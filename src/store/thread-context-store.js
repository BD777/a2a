import { join } from 'node:path';
import { JsonFileStore } from './json-file-store.js';

const SECTION_PROTOCOL_VERSION = 'context-v1';

export class ThreadContextStore {
  constructor({ stateDir, seenMessageLimit = 5000 }) {
    this.sessionsFile = new JsonFileStore(join(stateDir, 'sessions.json'), {});
    this.sectionsFile = new JsonFileStore(join(stateDir, 'sections.json'), {});
    this.seenFile = new JsonFileStore(join(stateDir, 'seen-messages.json'), []);
    this.sessions = new Map();
    this.sections = {};
    this.seen = new Set();
    this.seenMessageLimit = Math.max(0, Number(seenMessageLimit) || 0);
  }

  load() {
    const sessions = this.sessionsFile.read();
    this.sessions = new Map(Object.entries(sessions).filter(([, session]) => session?.status === 'running'));
    this.sections = this.sectionsFile.read();
    const seen = this.seenFile.read();
    this.seen = new Set(Array.isArray(seen) ? seen.filter((item) => typeof item === 'string') : []);
  }

  saveSessions() {
    this.sessionsFile.write(Object.fromEntries(this.sessions.entries()));
  }

  saveSections() {
    this.sectionsFile.write(this.sections);
  }

  saveSeen() {
    const cap = this.seenMessageLimit;
    const arr = Array.from(this.seen);
    this.seenFile.write(cap > 0 ? arr.slice(-cap) : arr);
  }

  markSeen(messageId) {
    if (!messageId) return false;
    if (this.seen.has(messageId)) return false;
    this.seen.add(messageId);
    const cap = this.seenMessageLimit;
    if (cap > 0 && this.seen.size > cap) {
      const first = this.seen.values().next().value;
      if (first) this.seen.delete(first);
    }
    this.saveSeen();
    return true;
  }

  getSession(rootMessageId) {
    return this.sessions.get(rootMessageId) || null;
  }

  runningSessions() {
    return Array.from(this.sessions.values()).filter((session) => session?.status === 'running');
  }

  findById(sessionId) {
    if (!sessionId) return null;
    for (const session of this.sessions.values()) {
      if (session?.id === sessionId) return session;
    }
    return null;
  }

  createSession(record, initialContext) {
    const prior = this.sections[record.rootMessageId] || {};
    const priorAgentState = prior.protocolVersion === SECTION_PROTOCOL_VERSION
      ? prior.agentState || {}
      : {};
    const inheritedAgentState = {};
    for (const [cliId, state] of Object.entries(priorAgentState)) {
      inheritedAgentState[cliId] = {
        threadId: state?.threadId || '',
        fullContextSent: !!state?.fullContextSent,
        transcriptDelivered: 0,
        userUpdatesDelivered: 0,
      };
    }
    const session = {
      id: sessionIdFor(record.rootMessageId),
      status: 'running',
      appId: record.appId,
      chatId: record.chatId,
      chatType: record.chatType,
      rootMessageId: record.rootMessageId,
      triggerMode: record.triggerMode || 'auto',
      initialContext,
      userUpdates: [messageRecordForPrompt(record)],
      transcript: [],
      agentState: inheritedAgentState,
      round: 1,
      turnsSinceUser: 0,
      quietStreak: 0,
      waitingFor: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.sessions.set(session.rootMessageId, session);
    this.persistSession(session);
    return session;
  }

  persistSession(session) {
    session.updatedAt = Date.now();
    this.sessions.set(session.rootMessageId, session);
    this.sections[session.rootMessageId] = {
      id: session.id,
      protocolVersion: SECTION_PROTOCOL_VERSION,
      chatId: session.chatId,
      chatType: session.chatType,
      rootMessageId: session.rootMessageId,
      agentState: session.agentState || {},
      status: session.status,
      updatedAt: session.updatedAt,
    };
    this.saveSessions();
    this.saveSections();
  }

  addUserUpdate(session, record) {
    if (session.userUpdates.some((item) => item.messageId === record.messageId)) return false;
    session.userUpdates.push(messageRecordForPrompt(record));
    session.turnsSinceUser = 0;
    session.quietStreak = 0;
    this.persistSession(session);
    return true;
  }

  finishSession(session, status = 'done', reason = '') {
    session.status = status;
    session.finishedReason = reason;
    session.updatedAt = Date.now();
    this.sessions.delete(session.rootMessageId);
    this.sections[session.rootMessageId] = {
      id: session.id,
      protocolVersion: SECTION_PROTOCOL_VERSION,
      chatId: session.chatId,
      chatType: session.chatType,
      rootMessageId: session.rootMessageId,
      agentState: session.agentState || {},
      status,
      reason,
      updatedAt: session.updatedAt,
    };
    this.saveSessions();
    this.saveSections();
  }
}

function sessionIdFor(rootMessageId) {
  return rootMessageId.replace(/[^a-zA-Z0-9]/g, '').slice(-10) || Date.now().toString(36);
}

function messageRecordForPrompt(record) {
  return {
    messageId: record.messageId,
    sender: record.senderLabel,
    msgType: record.msgType || 'text',
    text: record.text || '',
    at: record.timeMs || Date.now(),
  };
}
