import {
  STREAMING_BODY_ELEMENT_ID,
  STREAMING_THINKING_ELEMENT_ID,
  buildFailedAgentCard,
  buildFinalAgentCard,
} from './cards.js';
import { couldBecomeInternalPromptLeak, isInternalPromptLeak } from '../protocol/agent-output.js';

const STATE = Object.freeze({
  RUNNING: 'running',
  OVERFLOWED: 'overflowed',
  FINALIZED: 'finalized',
  FAILED: 'failed',
});

export class StreamingCardController {
  constructor({
    cardMinter,
    cliId,
    round,
    template,
    clients,
    logger,
    textMs = 800,
    thinkMs = 1500,
    textMinChars = 30,
    byteLimit = 4500,
    fallback = null,
  }) {
    this.cardMinter = cardMinter;
    this.cliId = cliId;
    this.round = round;
    this.template = template;
    this.clients = clients;
    this.logger = logger;
    this.textMs = textMs;
    this.thinkMs = thinkMs;
    this.textMinChars = textMinChars;
    this.byteLimit = byteLimit;
    this.fallback = fallback;

    this.text = '';
    this.thinking = '';
    this.activityLines = [];
    this.lastFlushedTextLen = 0;
    this.lastFlushedThinkLen = 0;
    this.textDirty = false;
    this.thinkDirty = false;
    this.textTimer = null;
    this.thinkTimer = null;
    this.sequence = 1;
    this.flushChain = Promise.resolve();
    this.state = STATE.RUNNING;
    this.mintPromise = null;
    this.mintFailed = false;
    this.minted = null;
    this.textGuard = new StreamingTextGuard();
  }

  get messageId() {
    return this.minted?.messageId || null;
  }

  async start() {
    return this.ensureCard();
  }

  appendText(delta) {
    if (this.state !== STATE.RUNNING || !delta) return;
    const safeDelta = this.textGuard.append(delta);
    if (!safeDelta) return;
    const next = this.text + safeDelta;
    if (Buffer.byteLength(next, 'utf8') > this.byteLimit) {
      this.text = next.slice(0, sliceByByteLimit(next, this.byteLimit));
      this.state = STATE.OVERFLOWED;
      this.scheduleTextFlush();
      return;
    }
    this.text = next;
    this.scheduleTextFlush();
  }

  setText(full) {
    if (this.state !== STATE.RUNNING) return;
    const value = this.textGuard.set(full);
    if (value === this.text) return;
    if (Buffer.byteLength(value, 'utf8') > this.byteLimit) {
      this.text = value.slice(0, sliceByByteLimit(value, this.byteLimit));
      this.state = STATE.OVERFLOWED;
      this.scheduleTextFlush();
      return;
    }
    this.text = value;
    this.scheduleTextFlush();
  }

  appendThinking(delta) {
    if (this.state !== STATE.RUNNING || !delta) return;
    this.thinking += delta;
    this.scheduleThinkFlush();
  }

  setThinking(full) {
    if (this.state !== STATE.RUNNING) return;
    const value = String(full || '');
    if (value === this.thinking) return;
    this.thinking = value;
    this.scheduleThinkFlush();
  }

  appendActivity(line) {
    if (this.state !== STATE.RUNNING || !line) return;
    const value = String(line).trim();
    if (!value) return;
    this.activityLines.push(value);
    this.trimActivity();
    this.scheduleThinkFlush();
  }

  scheduleTextFlush() {
    this.textDirty = true;
    if (this.textTimer) return;
    this.textTimer = setTimeout(() => {
      this.textTimer = null;
      this.flushText().catch((err) => this.logFlushError('text', err));
    }, this.textMs);
  }

  scheduleThinkFlush() {
    this.thinkDirty = true;
    if (this.thinkTimer) return;
    this.thinkTimer = setTimeout(() => {
      this.thinkTimer = null;
      this.flushThink().catch((err) => this.logFlushError('thinking', err));
    }, this.thinkMs);
  }

  ensureCard() {
    if (this.mintPromise) return this.mintPromise;
    this.mintPromise = (async () => {
      try {
        const result = await this.cardMinter();
        if (!result || !result.cardId) {
          this.mintFailed = true;
          return null;
        }
        this.minted = result;
        return result;
      } catch (err) {
        this.mintFailed = true;
        this.logger?.warn?.(`streaming card mint failed: ${err?.message || err}`);
        return null;
      }
    })();
    return this.mintPromise;
  }

  async flushText() {
    if (!this.textDirty) return;
    if (this.text === '' && this.lastFlushedTextLen === 0) return;
    if (this.text.length - this.lastFlushedTextLen < this.textMinChars && this.state === STATE.RUNNING) {
      return;
    }
    this.textDirty = false;
    const snapshot = this.text;
    await this.runSerialized(async () => {
      const minted = await this.ensureCard();
      if (!minted) return;
      try {
        await this.clients.updateCardElementContent(
          minted.appId,
          minted.cardId,
          STREAMING_BODY_ELEMENT_ID,
          snapshot,
          this.nextSequence(),
        );
        this.lastFlushedTextLen = snapshot.length;
      } catch (err) {
        this.logFlushError('text', err);
      }
    });
  }

  async flushThink() {
    if (!this.thinkDirty) return;
    const snapshot = this.thinkingSnapshot();
    if (snapshot === '' && this.lastFlushedThinkLen === 0) return;
    this.thinkDirty = false;
    await this.runSerialized(async () => {
      const minted = await this.ensureCard();
      if (!minted) return;
      try {
        await this.clients.updateCardElementContent(
          minted.appId,
          minted.cardId,
          STREAMING_THINKING_ELEMENT_ID,
          snapshot,
          this.nextSequence(),
        );
        this.lastFlushedThinkLen = snapshot.length;
      } catch (err) {
        this.logFlushError('thinking', err);
      }
    });
  }

  async finalize({ content, threadId } = {}) {
    if (this.state === STATE.FINALIZED || this.state === STATE.FAILED) return null;
    this.cancelTimers();
    this.state = STATE.FINALIZED;
    const finalText = this.textGuard.final(content ?? this.text ?? '').trim();

    if (!this.mintPromise) {
      if (!finalText) return null;
      return this.runFallback(finalText, threadId);
    }

    const minted = await this.ensureCard();
    if (!minted) {
      if (!finalText) return null;
      return this.runFallback(finalText, threadId);
    }

    const thinking = this.thinkingSnapshot();
    if (!finalText && !thinking) {
      const deleted = await this.deleteStreamCard(minted, 'quiet');
      if (deleted) return { messageId: minted.messageId, threadId, suppressed: true };
    }

    const fits = Buffer.byteLength(finalText, 'utf8') <= this.byteLimit;
    if (fits) {
      const card = buildFinalAgentCard({
        cliId: this.cliId,
        round: this.round,
        content: finalText || '_(quiet turn: no visible output)_',
        thinking,
        template: this.template,
      });
      await this.runSerialized(async () => {
        try {
          await this.clients.replaceCard(minted.appId, minted.cardId, card, this.nextSequence());
        } catch (err) {
          this.logger?.warn?.(`streaming finalize failed: ${err?.message || err}`);
        }
      });
    } else {
      const fallbackResult = await this.runFallback(finalText, threadId);
      if (fallbackResult) {
        const deleted = await this.deleteStreamCard(minted, 'overflow');
        if (deleted) return { ...fallbackResult, suppressed: true, overflow: true };
      }

      const card = buildFinalAgentCard({
        cliId: this.cliId,
        round: this.round,
        content: '_(continued in next card →)_',
        thinking,
        template: this.template,
      });
      await this.runSerialized(async () => {
        try {
          await this.clients.replaceCard(minted.appId, minted.cardId, card, this.nextSequence());
        } catch (err) {
          this.logger?.warn?.(`streaming finalize (overflow) failed: ${err?.message || err}`);
        }
      });
      if (fallbackResult) return fallbackResult;
    }
    return { messageId: minted.messageId, threadId };
  }

  async deleteStreamCard(minted, reason) {
    if (!minted?.messageId || typeof this.clients.deleteMessage !== 'function') return false;
    try {
      await this.clients.deleteMessage(minted.appId, minted.messageId);
      this.logger?.info?.(`streaming ${reason || 'unused'} card deleted msg=${minted.messageId}`);
      return true;
    } catch (err) {
      this.logger?.warn?.(`streaming ${reason || 'unused'}-card delete failed: ${err?.message || err}`);
      return false;
    }
  }

  async fail(err) {
    if (this.state === STATE.FINALIZED || this.state === STATE.FAILED) return null;
    this.cancelTimers();
    this.state = STATE.FAILED;

    if (!this.mintPromise || this.mintFailed) {
      this.logger?.debug?.(`streaming fail before mint: ${err?.message || err}`);
      return null;
    }

    const minted = await this.ensureCard();
    if (!minted) return null;

    const errorMessage = trimErrorMessage(err?.message || 'turn failed', Math.min(this.byteLimit || 1200, 1200));
    const card = buildFailedAgentCard({
      cliId: this.cliId,
      round: this.round,
      content: this.text,
      thinking: this.thinkingSnapshot(),
      errorMessage,
    });
    let replaced = false;
    await this.runSerialized(async () => {
      try {
        await this.clients.replaceCard(minted.appId, minted.cardId, card, this.nextSequence());
        replaced = true;
      } catch (e) {
        this.logger?.warn?.(`streaming fail-card replace failed: ${e?.message || e}`);
      }
    });
    return replaced ? { messageId: minted.messageId, failed: true } : null;
  }

  async runFallback(finalText, threadId) {
    if (!this.fallback) return null;
    try {
      const fallbackId = await this.fallback({ content: finalText, round: this.round });
      return { messageId: fallbackId || null, threadId };
    } catch (err) {
      this.logger?.warn?.(`streaming finalize fallback failed: ${err?.message || err}`);
      return null;
    }
  }

  cancelTimers() {
    if (this.textTimer) {
      clearTimeout(this.textTimer);
      this.textTimer = null;
    }
    if (this.thinkTimer) {
      clearTimeout(this.thinkTimer);
      this.thinkTimer = null;
    }
  }

  runSerialized(fn) {
    const next = this.flushChain.then(fn, fn);
    this.flushChain = next.catch(() => {});
    return next;
  }

  nextSequence() {
    const value = this.sequence;
    this.sequence += 1;
    return value;
  }

  thinkingSnapshot() {
    const parts = [];
    if (this.activityLines.length > 0) {
      parts.push(['**Activity**', ...this.activityLines].join('\n'));
    }
    if (this.thinking.trim()) {
      parts.push(`**Reasoning**\n${this.thinking.trim()}`);
    }
    return trimToByteLimit(parts.join('\n\n'), this.byteLimit);
  }

  trimActivity() {
    while (
      this.activityLines.length > 1
      && Buffer.byteLength(this.activityLines.join('\n'), 'utf8') > this.byteLimit
    ) {
      this.activityLines.shift();
    }
  }

  logFlushError(kind, err) {
    this.logger?.warn?.(`streaming ${kind} flush failed card=${this.minted?.cardId || '(unminted)'}: ${err?.message || err}`);
  }
}

class StreamingTextGuard {
  constructor() {
    this.pending = '';
    this.safe = false;
    this.blocked = false;
  }

  append(delta) {
    if (this.blocked) return '';
    if (this.safe) return String(delta || '');
    this.pending += String(delta || '');
    if (isInternalPromptLeak(this.pending)) {
      this.blocked = true;
      this.pending = '';
      return '';
    }
    if (couldBecomeInternalPromptLeak(this.pending)) return '';
    this.safe = true;
    const flushed = this.pending;
    this.pending = '';
    return flushed;
  }

  set(full) {
    const value = String(full || '');
    if (this.blocked || isInternalPromptLeak(value)) {
      this.blocked = true;
      this.pending = '';
      return '';
    }
    this.safe = true;
    this.pending = '';
    return value;
  }

  final(value) {
    const text = String(value || '');
    if (this.blocked || isInternalPromptLeak(text)) return '';
    return text;
  }
}

function sliceByByteLimit(text, byteLimit) {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const charBytes = Buffer.byteLength(text[i], 'utf8');
    if (bytes + charBytes > byteLimit) return i || 1;
    bytes += charBytes;
  }
  return text.length;
}

function trimToByteLimit(text, byteLimit) {
  if (!byteLimit || Buffer.byteLength(text, 'utf8') <= byteLimit) return text;
  const prefix = '_Showing latest activity._\n\n';
  const available = Math.max(1, byteLimit - Buffer.byteLength(prefix, 'utf8'));
  const tailStart = tailStartByByteLimit(text, available);
  return prefix + text.slice(tailStart);
}

function trimErrorMessage(text, byteLimit) {
  const value = String(text || '').trim() || 'turn failed';
  if (!byteLimit || Buffer.byteLength(value, 'utf8') <= byteLimit) return value;
  const suffix = '...';
  const available = Math.max(1, byteLimit - Buffer.byteLength(suffix, 'utf8'));
  let bytes = 0;
  let out = '';
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > available) break;
    bytes += charBytes;
    out += char;
  }
  return `${out.trimEnd()}${suffix}`;
}

function tailStartByByteLimit(text, byteLimit) {
  let bytes = 0;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    const charBytes = Buffer.byteLength(text[i], 'utf8');
    if (bytes + charBytes > byteLimit) return i + 1;
    bytes += charBytes;
  }
  return 0;
}
