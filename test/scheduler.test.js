import { test } from 'node:test';
import assert from 'node:assert/strict';
import { A2AScheduler } from '../src/scheduler/a2a-scheduler.js';
import { createMessages } from '../src/protocol/messages.js';

const messages = createMessages();

function noopLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

function makeStore() {
  const sessions = new Map();
  const seen = new Set();
  return {
    sessions,
    markSeen(id) { if (seen.has(id)) return false; seen.add(id); return true; },
    getSession(root) { return sessions.get(root) || null; },
    runningSessions() { return [...sessions.values()].filter((s) => s.status === 'running'); },
    createSession(record, initialContext) {
      const session = {
        id: record.rootMessageId.slice(-6),
        status: 'running',
        appId: record.appId,
        chatId: record.chatId,
        rootMessageId: record.rootMessageId,
        triggerMode: record.triggerMode || 'auto',
        initialContext,
        initialAttachments: record.initialAttachments || [],
        userUpdates: [{ messageId: record.messageId, sender: record.senderLabel, text: record.text, attachments: record.attachments || [], at: record.timeMs }],
        transcript: [],
        agentState: {},
        round: 1,
        turnsSinceUser: 0,
        quietStreak: 0,
        waitingFor: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      sessions.set(record.rootMessageId, session);
      return session;
    },
    persistSession(s) { s.updatedAt = Date.now(); sessions.set(s.rootMessageId, s); },
    addUserUpdate(s, r) {
      if (s.userUpdates.some((item) => item.messageId === r.messageId)) return false;
      s.userUpdates.push({ messageId: r.messageId, sender: r.senderLabel, text: r.text, attachments: r.attachments || [], at: r.timeMs });
      s.turnsSinceUser = 0;
      s.quietStreak = 0;
      return true;
    },
    finishSession(s, status, reason) {
      s.status = status;
      s.finishedReason = reason;
      sessions.delete(s.rootMessageId);
    },
  };
}

function makeRuntime(turnHandler) {
  return {
    stateFor(session, cliId) {
      if (!session.agentState[cliId]) {
        session.agentState[cliId] = { threadId: '', fullContextSent: false, transcriptDelivered: 0, userUpdatesDelivered: 0 };
      }
      return session.agentState[cliId];
    },
    peerCliId(cliId) {
      return cliId === 'claude-code' ? 'codex' : 'claude-code';
    },
    async runTurn(session, cliId, prompt, options) {
      return turnHandler({ session, cliId, prompt, options });
    },
  };
}

function makePublisher() {
  return {
    published: [],
    async publishSystem(session, text, opts) {
      this.published.push({ kind: 'system', text, level: opts?.level || 'info', cliId: opts?.cliId || '' });
    },
    async publishAgent(session, cliId, { content }) {
      if (!content?.trim()) return null;
      this.published.push({ kind: 'agent', cliId, content });
    },
    firstAgent() { return { larkAppId: 'app1' }; },
  };
}

function makeConfig(overrides = {}) {
  return {
    ownedChatIds: new Set(['oc_x']),
    agentOrder: ['claude-code', 'codex'],
    maxTurnsSinceUser: 4,
    publishSystemLifecycle: false,
    sessionTimeoutMs: 0,
    timeZone: 'Asia/Shanghai',
    ...overrides,
  };
}

function record(overrides = {}) {
  return {
    appId: 'app1', source: 'feishu-ws',
    messageId: 'mid-1', rootMessageId: 'mid-1', chatId: 'oc_x', chatType: 'group',
    msgType: 'text', text: 'hello agents',
    senderType: 'user', senderId: 'open_u1', senderLabel: 'Alice (user:open_u1)',
    timeMs: 1717000000000,
    ...overrides,
  };
}

test('shouldAutoStart: only owned chats, no slash-other-commands, requires text', () => {
  const cfg = makeConfig();
  const sched = new A2AScheduler({
    store: makeStore(), contextProvider: { readTopic: async () => 'ctx' },
    runtime: makeRuntime(), publisher: makePublisher(), config: cfg, logger: noopLogger(), messages,
  });
  assert.equal(sched.shouldAutoStart(record({ chatId: 'other' })), false);
  assert.equal(sched.shouldAutoStart(record({ text: '' })), false);
  assert.equal(sched.shouldAutoStart(record({ text: '/help me' })), false);
  assert.equal(sched.shouldAutoStart(record({ text: '/a2a status' })), true);
  assert.equal(sched.shouldAutoStart(record({ text: 'plain text' })), true);
});

test('auto-start triggers claude turn first, then alternates', async () => {
  const cfg = makeConfig();
  const turns = [];
  const rt = makeRuntime(async ({ cliId }) => {
    turns.push(cliId);
    // 2 non-empty turns then both go quiet; quietStreak must reach agentOrder.length (2)
    return { content: turns.length < 3 ? `from ${cliId}` : '', provider: 't', threadId: `t-${cliId}` };
  });
  const pub = makePublisher();
  const sched = new A2AScheduler({
    store: makeStore(), contextProvider: { readTopic: async () => 'ctx' },
    runtime: rt, publisher: pub, config: cfg, logger: noopLogger(), messages,
  });

  await sched.handleUserMessage(record());
  assert.deepEqual(turns, ['claude-code', 'codex', 'claude-code', 'codex']);
  // first 2 had content, last 2 were empty → 2 agent publishes
  const agentPublished = pub.published.filter((p) => p.kind === 'agent');
  assert.equal(agentPublished.length, 2);
});

test('passes topic and user-update images to runtime input options', async () => {
  const cfg = makeConfig({ maxTurnsSinceUser: 1 });
  const seenAttachments = [];
  const rt = makeRuntime(async ({ prompt, options }) => {
    seenAttachments.push(options.attachments);
    assert.match(prompt, /available as visual input/);
    return { content: 'done', provider: 't', threadId: '' };
  });
  const pub = makePublisher();
  const sched = new A2AScheduler({
    store: makeStore(),
    contextProvider: {
      readTopic: async () => ({
        text: 'ctx [image]',
        attachments: [{ kind: 'image', messageId: 'mid-ctx', fileKey: 'img-ctx', localPath: '/tmp/ctx.png', mimeType: 'image/png' }],
      }),
    },
    runtime: rt,
    publisher: pub,
    config: cfg,
    logger: noopLogger(),
    messages,
  });

  await sched.handleUserMessage(record({
    text: '[image]',
    attachments: [{ kind: 'image', messageId: 'mid-1', fileKey: 'img-user', localPath: '/tmp/user.png', mimeType: 'image/png' }],
  }));
  assert.equal(seenAttachments.length, 1);
  assert.equal(seenAttachments[0].length, 2);
  assert.deepEqual(seenAttachments[0].map((item) => item.fileKey), ['img-ctx', 'img-user']);
});

test('maxTurnsSinceUser stops the loop', async () => {
  const cfg = makeConfig({ maxTurnsSinceUser: 2 });
  const turns = [];
  const rt = makeRuntime(async ({ cliId }) => {
    turns.push(cliId);
    return { content: `${cliId} keeps talking`, provider: 't', threadId: '' };
  });
  const pub = makePublisher();
  const store = makeStore();
  const sched = new A2AScheduler({
    store, contextProvider: { readTopic: async () => 'ctx' },
    runtime: rt, publisher: pub, config: cfg, logger: noopLogger(), messages,
  });

  await sched.handleUserMessage(record());
  assert.equal(turns.length, 2);
  // finishSession deletes from sessions map
  assert.equal(store.sessions.size, 0);
  // system message includes the cap reason
  assert.ok(pub.published.some((p) => p.kind === 'system' && /2 turns/.test(p.text)));
});

test('user update inside running session resets turnsSinceUser', async () => {
  const cfg = makeConfig({ maxTurnsSinceUser: 10 });
  const rt = makeRuntime(async ({ cliId }) => ({ content: `${cliId} text`, provider: 't', threadId: '' }));
  // Stop after first turn so we can observe state.
  let count = 0;
  const rt2 = makeRuntime(async ({ cliId }) => {
    count += 1;
    if (count >= 1) {
      return { content: '', provider: 't', threadId: '' }; // both go quiet immediately
    }
    return { content: cliId, provider: 't', threadId: '' };
  });
  const store = makeStore();
  const sched = new A2AScheduler({
    store, contextProvider: { readTopic: async () => 'ctx' },
    runtime: rt2, publisher: makePublisher(), config: cfg, logger: noopLogger(), messages,
  });
  await sched.handleUserMessage(record());
  // session ended; addUserUpdate path needs a *running* session.
  // Build a fresh session manually to test addUserUpdate logic via scheduler.
  const root = 'r-update';
  const created = store.createSession(record({ rootMessageId: root, messageId: 'orig' }), 'ctx');
  created.turnsSinceUser = 5;
  await sched.handleUserMessage(record({ rootMessageId: root, messageId: 'u2', text: 'more thoughts' }));
  assert.equal(created.turnsSinceUser, 0);
});

test('turn failure suppresses system card when streaming failure card was posted', async () => {
  const cfg = makeConfig();
  const store = makeStore();
  const pub = makePublisher();
  const err = new Error('codex response failed (cyber_policy): blocked');
  err.streamFailureMessageId = 'failed-card-msg';
  const sched = new A2AScheduler({
    store,
    contextProvider: { readTopic: async () => 'ctx' },
    runtime: makeRuntime(async () => { throw err; }),
    publisher: pub,
    config: cfg,
    logger: noopLogger(),
    messages,
  });

  await sched.handleUserMessage(record());
  assert.equal(store.sessions.size, 0);
  assert.equal(pub.published.some((p) => p.kind === 'system' && /failed/.test(p.text)), false);
});

test('turn failure publishes system card via failing cli when no streaming failure card exists', async () => {
  const cfg = makeConfig();
  const store = makeStore();
  const pub = makePublisher();
  const sched = new A2AScheduler({
    store,
    contextProvider: { readTopic: async () => 'ctx' },
    runtime: makeRuntime(async () => { throw new Error('plain failure'); }),
    publisher: pub,
    config: cfg,
    logger: noopLogger(),
    messages,
  });

  await sched.handleUserMessage(record());
  const failedSystem = pub.published.find((p) => p.kind === 'system' && /plain failure/.test(p.text));
  assert.ok(failedSystem);
  assert.equal(failedSystem.cliId, 'claude-code');
});

test('/a2a stop ends running session', async () => {
  const cfg = makeConfig();
  const store = makeStore();
  const pub = makePublisher();
  const sched = new A2AScheduler({
    store, contextProvider: { readTopic: async () => 'ctx' },
    runtime: makeRuntime(), publisher: pub, config: cfg, logger: noopLogger(), messages,
  });
  const created = store.createSession(record({ rootMessageId: 'rstop' }), 'ctx');
  assert.equal(created.status, 'running');
  await sched.handleUserMessage(record({ rootMessageId: 'rstop', messageId: 'stop1', text: '/a2a stop' }));
  assert.equal(created.status, 'stopped');
});

test('isSessionExpired honors createdAt + sessionTimeoutMs', () => {
  const cfg = makeConfig({ sessionTimeoutMs: 1000 });
  const sched = new A2AScheduler({
    store: makeStore(), contextProvider: { readTopic: async () => 'ctx' },
    runtime: makeRuntime(), publisher: makePublisher(), config: cfg, logger: noopLogger(), messages,
  });
  assert.equal(sched.isSessionExpired({ createdAt: Date.now() - 500 }), false);
  assert.equal(sched.isSessionExpired({ createdAt: Date.now() - 5000 }), true);
});

test('listSessions returns a summary of running sessions', () => {
  const cfg = makeConfig();
  const store = makeStore();
  const sched = new A2AScheduler({
    store, contextProvider: { readTopic: async () => 'ctx' },
    runtime: makeRuntime(), publisher: makePublisher(), config: cfg, logger: noopLogger(), messages,
  });
  store.createSession(record({ rootMessageId: 'ra', messageId: 'ma' }), 'ctx');
  store.createSession(record({ rootMessageId: 'rb', messageId: 'mb' }), 'ctx');
  const list = sched.listSessions();
  assert.equal(list.length, 2);
  assert.ok(list[0].id);
  assert.ok(Number.isFinite(list[0].createdAt));
});

test('stopById stops the matching running session', async () => {
  const cfg = makeConfig();
  const store = makeStore();
  const pub = makePublisher();
  const sched = new A2AScheduler({
    store, contextProvider: { readTopic: async () => 'ctx' },
    runtime: makeRuntime(), publisher: pub, config: cfg, logger: noopLogger(), messages,
  });
  // store.findById is used by stopById; make sure mock store provides it
  store.findById = (id) => [...store.sessions.values()].find((s) => s.id === id) || null;
  const created = store.createSession(record({ rootMessageId: 'rkill' }), 'ctx');
  const result = await sched.stopById(created.id, 'admin-test');
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, created.id);
  assert.equal(created.status, 'stopped');
  assert.ok(pub.published.some((p) => p.kind === 'system' && /admin-test/.test(p.text)));
});

test('stopById returns not_found for unknown session', async () => {
  const cfg = makeConfig();
  const store = makeStore();
  store.findById = (id) => [...store.sessions.values()].find((s) => s.id === id) || null;
  const sched = new A2AScheduler({
    store, contextProvider: { readTopic: async () => 'ctx' },
    runtime: makeRuntime(), publisher: makePublisher(), config: cfg, logger: noopLogger(), messages,
  });
  const result = await sched.stopById('nope');
  assert.deepEqual(result, { ok: false, error: 'not_found' });
});
