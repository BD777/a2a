import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseAgentOutput } from '../protocol/agent-output.js';
import { usableImageAttachments } from '../feishu/attachment-downloader.js';

const DEFAULT_SSE_ERROR_LOG = join(homedir(), '.codex', 'modelhub-proxy', 'sse-errors.log');
const SSE_ERROR_LOG_TAIL_BYTES = 512 * 1024;

export class CodexSdkRuntime {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.client = null;
  }

  async runTurn({ bot, prompt, attachments, state, signal, stream }) {
    const { Codex } = await import('@openai/codex-sdk');
    if (!this.client) {
      this.client = new Codex({
        codexPathOverride: this.config.codex.codexPathOverride || undefined,
      });
    }

    const options = {
      workingDirectory: bot.workingDir || this.config.projectDir,
      skipGitRepoCheck: true,
      modelReasoningEffort: this.config.codex.reasoningEffort,
    };
    // Pass-through only when explicitly configured; empty values let the SDK
    // fall back to the user's ~/.codex/config.toml so A2A inherits whatever
    // sandbox / web-search posture the user already set up interactively.
    if (this.config.codex.sandboxMode) options.sandboxMode = this.config.codex.sandboxMode;
    if (this.config.codex.approvalPolicy) options.approvalPolicy = this.config.codex.approvalPolicy;
    if (this.config.codex.webSearchMode) options.webSearchMode = this.config.codex.webSearchMode;
    if (this.config.codex.model) options.model = this.config.codex.model;

    const thread = state.threadId
      ? this.client.resumeThread(state.threadId, options)
      : this.client.startThread(options);
    let threadId = thread.id || state.threadId || '';
    const input = buildCodexInput(prompt, attachments);

    if (stream && typeof thread.runStreamed === 'function') {
      const streamed = await thread.runStreamed(input, { signal });
      let finalResponse = '';
      let usage = null;
      try {
        for await (const event of streamed.events) {
          if (event.type === 'thread.started') {
            threadId = event.thread_id || threadId;
          } else if (event.type === 'item.updated' || event.type === 'item.completed') {
            const item = event.item;
            if (item?.type === 'agent_message') {
              stream.setText(item.text || '');
              if (event.type === 'item.completed') finalResponse = item.text || finalResponse;
            } else if (item?.type === 'reasoning') {
              stream.setThinking(item.text || '');
            }
          } else if (event.type === 'turn.completed') {
            usage = event.usage || null;
          } else if (event.type === 'turn.failed') {
            throw makeCodexError(event.error, 'codex turn failed');
          } else if (event.type === 'error') {
            throw makeCodexError(event, 'codex thread error');
          }
        }
      } catch (err) {
        throw enrichCodexError(err, { threadId: threadId || thread.id, logPath: this.config.codex.sseErrorLogPath });
      }
      const output = parseAgentOutput(finalResponse);
      return {
        ...output,
        provider: 'codex-sdk',
        threadId: threadId || thread.id || state.threadId || '',
        usage,
      };
    }

    let turn;
    try {
      turn = await thread.run(input, { signal });
    } catch (err) {
      throw enrichCodexError(err, { threadId: thread.id || threadId, logPath: this.config.codex.sseErrorLogPath });
    }
    const output = parseAgentOutput(turn.finalResponse);
    return {
      ...output,
      provider: 'codex-sdk',
      threadId: thread.id || state.threadId || '',
      usage: turn.usage || null,
    };
  }
}

export function buildCodexInput(prompt, attachments = []) {
  const images = usableImageAttachments(attachments);
  if (images.length === 0) return prompt;
  return [
    { type: 'text', text: prompt },
    ...images.map((image) => ({ type: 'local_image', path: image.localPath })),
  ];
}

function makeCodexError(error, fallbackMessage) {
  const err = new Error(error?.message || fallbackMessage);
  if (error?.code) err.code = error.code;
  if (error?.type) err.type = error.type;
  return err;
}

export function enrichCodexError(err, { threadId, logPath = DEFAULT_SSE_ERROR_LOG } = {}) {
  const original = err instanceof Error ? err : new Error(String(err || 'codex turn failed'));
  const diagnostic = readLatestCodexSseDiagnostic({ threadId, logPath });
  const details = diagnostic ? codexDiagnosticDetails(diagnostic) : null;
  if (!details?.message) return markCodexRetryability(original);

  const codePart = details.code ? ` (${details.code})` : '';
  const enriched = new Error(`codex response failed${codePart}: ${details.message}`, { cause: original });
  if (details.code) enriched.code = details.code;
  if (details.type) enriched.type = details.type;
  enriched.codexDiagnostic = diagnostic;
  return markCodexRetryability(enriched, details);
}

export function readLatestCodexSseDiagnostic({ threadId, logPath = DEFAULT_SSE_ERROR_LOG } = {}) {
  if (!threadId || !logPath || !existsSync(logPath)) return null;
  const text = readFileTail(logPath, SSE_ERROR_LOG_TAIL_BYTES);
  let latest = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    if (item?.session_id !== threadId) continue;
    const details = codexDiagnosticDetails(item.diagnostic);
    if (details.message) latest = item.diagnostic;
  }
  return latest;
}

function readFileTail(path, maxBytes) {
  let fd = null;
  try {
    const { size } = statSync(path);
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    fd = openSync(path, 'r');
    readSync(fd, buffer, 0, length, start);
    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function codexDiagnosticDetails(diagnostic) {
  const error = diagnostic?.error || diagnostic?.['response.error'] || {};
  return {
    type: error.type || diagnostic?.['error.type'] || '',
    code: error.code || diagnostic?.['error.code'] || '',
    message: error.message || diagnostic?.['error.message'] || '',
  };
}

function markCodexRetryability(err, details = null) {
  const code = String(details?.code || err.code || '').toLowerCase();
  const type = String(details?.type || err.type || '').toLowerCase();
  const message = String(details?.message || err.message || '').toLowerCase();
  if (
    code.includes('cyber_policy')
    || type === 'invalid_request'
    || message.includes('cybersecurity risk')
    || message.includes('content was flagged')
  ) {
    err.retryable = false;
  } else if (
    code.includes('rate_limit')
    || code.includes('too_many_requests')
    || type === 'too_many_requests'
    || type === 'server_error'
  ) {
    err.retryable = true;
  }
  return err;
}
