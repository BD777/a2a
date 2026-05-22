import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCodexInput,
  enrichCodexError,
  readLatestCodexSseDiagnostic,
} from '../src/runtime/codex-sdk-runtime.js';

function withTmpLog(lines, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-codex-sse-'));
  const logPath = join(dir, 'sse-errors.log');
  writeFileSync(logPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
  try {
    return fn(logPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function diagnostic({ type = 'invalid_request', code = 'cyber_policy', message = 'blocked' } = {}) {
  return {
    error: { type, code, message, param: null },
    type: 'error',
    'error.type': type,
    'error.code': code,
    'error.message': message,
    'error.param': null,
  };
}

test('readLatestCodexSseDiagnostic returns latest matching diagnostic with a message', () => {
  withTmpLog([
    { session_id: 'thread-1', event: 'error', diagnostic: diagnostic({ message: 'old error' }) },
    { session_id: 'thread-2', event: 'error', diagnostic: diagnostic({ message: 'other thread' }) },
    {
      session_id: 'thread-1',
      event: 'response.failed',
      diagnostic: { type: 'response.failed', 'response.error': null },
    },
    { session_id: 'thread-1', event: 'error', diagnostic: diagnostic({ message: 'latest error' }) },
  ], (logPath) => {
    const found = readLatestCodexSseDiagnostic({ threadId: 'thread-1', logPath });
    assert.equal(found['error.message'], 'latest error');
  });
});

test('enrichCodexError surfaces cyber policy diagnostics as non-retryable', () => {
  const message = 'This content was flagged for possible cybersecurity risk.';
  withTmpLog([
    { session_id: 'thread-policy', event: 'error', diagnostic: diagnostic({ message }) },
  ], (logPath) => {
    const original = new Error('stream disconnected before completion: response.failed event received');
    const enriched = enrichCodexError(original, { threadId: 'thread-policy', logPath });

    assert.match(enriched.message, /codex response failed \(cyber_policy\):/);
    assert.match(enriched.message, /cybersecurity risk/);
    assert.equal(enriched.code, 'cyber_policy');
    assert.equal(enriched.type, 'invalid_request');
    assert.equal(enriched.retryable, false);
    assert.equal(enriched.cause, original);
  });
});

test('enrichCodexError marks transient backend diagnostics as retryable', () => {
  withTmpLog([
    {
      session_id: 'thread-rate-limit',
      event: 'error',
      diagnostic: diagnostic({
        type: 'too_many_requests',
        code: 'rate_limit_exceeded',
        message: 'Rate limit reached, please retry later.',
      }),
    },
  ], (logPath) => {
    const enriched = enrichCodexError(new Error('response failed'), {
      threadId: 'thread-rate-limit',
      logPath,
    });

    assert.equal(enriched.code, 'rate_limit_exceeded');
    assert.equal(enriched.type, 'too_many_requests');
    assert.equal(enriched.retryable, true);
  });
});

test('buildCodexInput adds local_image blocks for downloaded images', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-codex-image-'));
  const imagePath = join(dir, 'image.png');
  writeFileSync(imagePath, Buffer.from('89504e470d0a1a0a0000000d', 'hex'));
  try {
    const input = buildCodexInput('look', [{ kind: 'image', localPath: imagePath, mimeType: 'image/png' }]);
    assert.deepEqual(input, [
      { type: 'text', text: 'look' },
      { type: 'local_image', path: imagePath },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
