import { buildAgentPrompt } from '../protocol/prompt.js';
const STOP_RE = /^\/a2a\s+(stop|cancel|end)\b/i;
const STATUS_RE = /^\/a2a\s+status\b/i;
const COMMAND_RE = /^\/\S+/;

export class A2AScheduler {
  constructor({ store, contextProvider, runtime, publisher, config, logger, messages }) {
    this.store = store;
    this.contextProvider = contextProvider;
    this.runtime = runtime;
    this.publisher = publisher;
    this.config = config;
    this.logger = logger;
    this.messages = messages;
  }

  async handleUserMessage(record) {
    const text = (record.text || '').trim();
    if (!text) return;

    const root = record.rootMessageId;
    if (STOP_RE.test(text)) return this.stop(root);
    if (STATUS_RE.test(text)) return this.status(root, record);

    if (!this.store.markSeen(record.messageId)) {
      this.logger.debug(`duplicate message ignored: ${record.messageId}`);
      return;
    }

    const session = this.store.getSession(root);
    if (session) {
      const added = this.store.addUserUpdate(session, record);
      if (added) this.logger.info(`user update recorded session=${session.id} msg=${record.messageId}`);
      return;
    }

    if (!this.shouldAutoStart(record)) return;
    await this.start(record);
  }

  shouldAutoStart(record) {
    if (!this.config.ownedChatIds.has(record.chatId)) return false;
    if (!record.text.trim()) return false;
    if (COMMAND_RE.test(record.text) && !/^\/a2a\b/i.test(record.text)) return false;
    return true;
  }

  isSessionExpired(session) {
    const limit = Number(this.config.sessionTimeoutMs || 0);
    if (!limit) return false;
    const start = Number(session.createdAt || 0);
    if (!start) return false;
    return Date.now() - start > limit;
  }

  resumeRunningSessions() {
    for (const session of this.store.runningSessions()) {
      if (!session.waitingFor?.cliId) continue;
      this.logger.info(`resuming session=${session.id} waitingFor=${session.waitingFor.cliId} round=${session.waitingFor.round}`);
      this.routeNext(session, session.waitingFor.cliId).catch((err) => {
        this.logger.error(`resume failed session=${session.id}:`, err);
      });
    }
  }

  async start(record) {
    const topic = normalizeTopic(await this.contextProvider.readTopic(record.appId, record.chatId, record.rootMessageId));
    const session = this.store.createSession({
      ...record,
      triggerMode: 'auto',
      initialAttachments: topic.attachments,
    }, topic.text);
    session.initialAttachments = topic.attachments;
    this.store.persistSession(session);
    this.logger.info(`session started id=${session.id} root=${session.rootMessageId} chat=${session.chatId}`);
    if (this.config.publishSystemLifecycle) {
      await this.publisher.publishSystem(session, this.messages.render('lifecycle.start', { sessionId: session.id }));
    }
    await this.routeNext(session, this.config.agentOrder[0]);
  }

  async stop(rootMessageId) {
    const session = this.store.getSession(rootMessageId);
    if (!session) return;
    this.store.finishSession(session, 'stopped', 'user-stop');
    await this.publisher.publishSystem(session, this.messages.render('lifecycle.stop', { sessionId: session.id }));
  }

  async stopById(sessionId, reason = 'admin-stop') {
    const session = this.store.findById(sessionId);
    if (!session) return { ok: false, error: 'not_found' };
    this.store.finishSession(session, 'stopped', reason);
    try {
      await this.publisher.publishSystem(session, this.messages.render('lifecycle.stopVia', { sessionId: session.id, reason }));
    } catch (err) {
      this.logger.warn(`stopById publish failed for ${session.id}: ${err?.message || err}`);
    }
    return { ok: true, sessionId, rootMessageId: session.rootMessageId };
  }

  listSessions() {
    return this.store.runningSessions().map((session) => ({
      id: session.id,
      status: session.status,
      chatId: session.chatId,
      rootMessageId: session.rootMessageId,
      round: session.round,
      turnsSinceUser: session.turnsSinceUser,
      quietStreak: session.quietStreak,
      waitingFor: session.waitingFor,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      transcriptLen: (session.transcript || []).length,
    }));
  }

  async status(rootMessageId, record) {
    const session = this.store.getSession(rootMessageId);
    if (!session) {
      await this.publisher.publishSystem({
        rootMessageId,
      }, this.messages.render('lifecycle.statusNoSession'));
      return;
    }
    const waiting = session.waitingFor ? `${session.waitingFor.cliId} round ${session.waitingFor.round}` : 'idle';
    await this.publisher.publishSystem(session, this.messages.render('lifecycle.status', {
      sessionId: session.id,
      status: session.status,
      waiting,
      turns: session.transcript.length,
      turnsSinceUser: session.turnsSinceUser,
      maxTurnsSinceUser: this.config.maxTurnsSinceUser,
    }));
  }

  async routeNext(session, cliId) {
    if (session.status !== 'running') return;
    if (this.isSessionExpired(session)) {
      this.store.finishSession(session, 'done', 'session-timeout');
      await this.publisher.publishSystem(session, this.messages.render('lifecycle.sessionTimeout', {
        seconds: Math.round(this.config.sessionTimeoutMs / 1000),
      }));
      return;
    }
    const state = this.runtime.stateFor(session, cliId);
    const includeFullContext = !state.fullContextSent || !state.threadId;
    if (includeFullContext && !session.initialContext) {
      const topic = normalizeTopic(await this.contextProvider.readTopic(session.appId || this.publisher.firstAgent().larkAppId, session.chatId, session.rootMessageId));
      session.initialContext = topic.text;
      session.initialAttachments = topic.attachments;
    }

    const transcriptStart = includeFullContext ? 0 : state.transcriptDelivered;
    const userUpdatesStart = state.userUpdatesDelivered;
    const userUpdates = (session.userUpdates || []).slice(userUpdatesStart);
    const turnInput = {
      includeFullContext,
      topicContext: session.initialContext,
      transcript: (session.transcript || [])
        .slice(transcriptStart)
        .filter((item) => item.text?.trim())
        .filter((item) => includeFullContext || item.speaker !== cliId),
      userUpdates,
      userUpdatesEnd: (session.userUpdates || []).length,
    };
    const attachments = collectTurnAttachments({
      includeFullContext,
      initialAttachments: session.initialAttachments,
      userUpdates,
    });

    const round = session.round;
    session.waitingFor = { cliId, round };
    this.store.persistSession(session);

    const peerCliId = this.runtime.peerCliId(cliId);
    const peerCliIds = this.config.agentOrder.filter((id) => id !== cliId);
    const prompt = buildAgentPrompt({
      session,
      cliId,
      peerCliIds,
      round,
      turnInput,
      timeZone: this.config.timeZone,
      messages: this.messages,
    });

    this.logger.info(`agent turn start session=${session.id} cli=${cliId} round=${round} fullContext=${includeFullContext} transcriptDelta=${turnInput.transcript.length} userDelta=${turnInput.userUpdates.length} images=${attachments.filter((item) => item?.kind === 'image' && item.localPath).length}`);
    const turnStartedAt = Date.now();
    let result;
    try {
      const beginAttempt = () => this.publisher.beginAgentTurn?.(session, cliId, round);
      result = await this.runtime.runTurn(session, cliId, prompt, { beginAttempt, attachments });
    } catch (err) {
      this.logger.error(`agent turn failed session=${session.id} cli=${cliId}:`, err);
      session.waitingFor = null;
      this.store.finishSession(session, 'failed', `${cliId}: ${err?.message || err}`);
      if (!err?.streamFailureMessageId) {
        await this.publisher.publishSystem(session, this.messages.render('lifecycle.failed', {
          cliId,
          error: err?.message || err,
        }), { level: 'error', cliId });
      } else {
        this.logger.info(`failure system card suppressed session=${session.id} cli=${cliId} msg=${err.streamFailureMessageId}`);
      }
      return;
    }
    const turnDurationMs = Date.now() - turnStartedAt;

    const content = String(result.content || '').trim();
    session.waitingFor = null;
    session.transcript.push({
      speaker: cliId,
      round,
      text: content,
      provider: result.provider,
      at: Date.now(),
    });
    state.transcriptDelivered = (session.transcript || []).length;
    state.userUpdatesDelivered = turnInput.userUpdatesEnd;
    session.turnsSinceUser = Number(session.turnsSinceUser || 0) + 1;
    session.quietStreak = content ? 0 : Number(session.quietStreak || 0) + 1;
    this.store.persistSession(session);

    if (!result.streamMessageId) {
      await this.publisher.publishAgent(session, cliId, { content, round });
    }
    this.logger.info({
      event: 'turn_done',
      sessionId: session.id,
      cli: cliId,
      round,
      chars: content.length,
      durationMs: turnDurationMs,
      provider: result.provider,
      usage: result.usage || null,
      turnsSinceUser: session.turnsSinceUser,
      maxTurnsSinceUser: this.config.maxTurnsSinceUser,
      quietStreak: session.quietStreak,
      agentCount: this.config.agentOrder.length,
    });

    if (session.quietStreak >= this.config.agentOrder.length) {
      this.store.finishSession(session, 'done', 'quiet');
      return;
    }

    if (session.turnsSinceUser >= this.config.maxTurnsSinceUser) {
      this.store.finishSession(session, 'done', 'max-turns');
      await this.publisher.publishSystem(session, this.messages.render('lifecycle.maxTurns', {
        maxTurnsSinceUser: this.config.maxTurnsSinceUser,
      }));
      return;
    }

    session.round += 1;
    this.store.persistSession(session);
    await this.routeNext(session, peerCliId);
  }
}

function normalizeTopic(topic) {
  if (typeof topic === 'string') return { text: topic, attachments: [] };
  return {
    text: topic?.text || '',
    attachments: Array.isArray(topic?.attachments) ? topic.attachments : [],
  };
}

function collectTurnAttachments({ includeFullContext, initialAttachments, userUpdates }) {
  const candidates = [
    ...(includeFullContext && Array.isArray(initialAttachments) ? initialAttachments : []),
    ...(Array.isArray(userUpdates) ? userUpdates.flatMap((item) => item.attachments || []) : []),
  ];
  const seen = new Set();
  const result = [];
  for (const item of candidates) {
    if (!item || typeof item !== 'object') continue;
    const key = item.localPath || `${item.messageId || ''}:${item.fileKey || ''}:${item.kind || ''}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}
