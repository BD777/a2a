import { ClaudeAgentRuntime } from './claude-agent-runtime.js';
import { CodexSdkRuntime } from './codex-sdk-runtime.js';
import { runWithRetry } from './retry.js';

const RUNTIME_CONSTRUCTORS = {
  claude: ClaudeAgentRuntime,
  codex: CodexSdkRuntime,
};

function inferRuntimeKind(cliId) {
  if (!cliId) return '';
  const lower = String(cliId).toLowerCase();
  if (lower.startsWith('claude')) return 'claude';
  if (lower.startsWith('codex')) return 'codex';
  return '';
}

export class AgentRuntimeManager {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.runtimes = new Map();
    for (const cliId of config.agentOrder) {
      const bot = config.agents.get(cliId);
      if (!bot) continue;
      const kind = bot.runtime || inferRuntimeKind(cliId);
      const Ctor = RUNTIME_CONSTRUCTORS[kind];
      if (!Ctor) {
        throw new Error(`unknown runtime kind for cliId=${cliId}: "${kind || '(unset)'}". add "runtime": "claude" | "codex" to the agent in agents.json`);
      }
      this.runtimes.set(cliId, new Ctor({ config, logger }));
    }
  }

  bot(cliId) {
    const bot = this.config.agents.get(cliId);
    if (!bot) throw new Error(`unknown A2A agent: ${cliId}`);
    return bot;
  }

  peerCliId(cliId) {
    const order = this.config.agentOrder;
    if (order.length < 2) return cliId;
    const index = Math.max(0, order.indexOf(cliId));
    return order[(index + 1) % order.length];
  }

  stateFor(session, cliId) {
    if (!session.agentState || typeof session.agentState !== 'object') session.agentState = {};
    if (!session.agentState[cliId]) {
      session.agentState[cliId] = {
        threadId: '',
        fullContextSent: false,
        transcriptDelivered: 0,
        userUpdatesDelivered: 0,
      };
    }
    const state = session.agentState[cliId];
    state.transcriptDelivered = Number(state.transcriptDelivered || 0);
    state.userUpdatesDelivered = Number(state.userUpdatesDelivered || 0);
    state.fullContextSent = !!state.fullContextSent;
    state.threadId = state.threadId || '';
    return state;
  }

  async runTurn(session, cliId, prompt, { beginAttempt } = {}) {
    const runtime = this.runtimes.get(cliId);
    if (!runtime) throw new Error(`no runtime registered for ${cliId}`);
    const state = this.stateFor(session, cliId);
    const retry = this.config.turnRetry || { attempts: 0, baseMs: 2000, capMs: 30000 };

    const result = await runWithRetry({
      attempts: retry.attempts,
      baseMs: retry.baseMs,
      capMs: retry.capMs,
      onRetry: ({ attempt, totalAttempts, delayMs, err }) => {
        this.logger.warn(`agent turn retry session=${session.id} cli=${cliId} attempt=${attempt}/${totalAttempts} delay=${delayMs}ms err=${err?.message || err}`);
      },
      fn: () => this.runTurnOnce({ session, cliId, prompt, runtime, state, beginAttempt }),
    });

    if (result.threadId) state.threadId = result.threadId;
    state.fullContextSent = true;
    return result;
  }

  async runTurnOnce({ session, cliId, prompt, runtime, state, beginAttempt }) {
    const controller = new AbortController();
    const timeoutMs = this.config.turnTimeoutMs;
    const timer = setTimeout(() => controller.abort(new Error(`turn timed out after ${timeoutMs}ms`)), timeoutMs);
    let stream = null;
    if (typeof beginAttempt === 'function') {
      try {
        stream = await beginAttempt();
      } catch (err) {
        this.logger.warn(`beginAttempt failed session=${session.id} cli=${cliId}: ${err?.message || err}`);
        stream = null;
      }
    }
    try {
      const result = await runtime.runTurn({
        bot: this.bot(cliId),
        prompt,
        state,
        session,
        cliId,
        signal: controller.signal,
        stream,
      });
      let streamResult = null;
      if (stream) {
        streamResult = await stream.finalize({ content: result.content, threadId: result.threadId });
      }
      return { ...result, streamMessageId: streamResult?.messageId || stream?.messageId || null };
    } catch (err) {
      let streamFailure = null;
      if (stream) {
        try {
          streamFailure = await stream.fail(err);
          if (streamFailure?.messageId && err && typeof err === 'object') {
            err.streamFailureMessageId = streamFailure.messageId;
          }
        } catch (_) { /* ignore secondary failure */ }
      }
      if (controller.signal.aborted) {
        const timeoutErr = new Error(`${cliId} turn timed out after ${timeoutMs}ms`);
        timeoutErr.code = 'EA2A_TURN_TIMEOUT';
        timeoutErr.retryable = false;
        timeoutErr.cause = err;
        if (streamFailure?.messageId || err?.streamFailureMessageId) {
          timeoutErr.streamFailureMessageId = streamFailure?.messageId || err.streamFailureMessageId;
        }
        throw timeoutErr;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
