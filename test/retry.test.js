import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRetryable, runWithRetry, backoffDelay } from '../src/runtime/retry.js';

test('isRetryable: network codes', () => {
  for (const code of ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN']) {
    const err = new Error(code);
    err.code = code;
    assert.equal(isRetryable(err), true, code);
  }
});

test('isRetryable: 5xx + 429 + 408', () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    assert.equal(isRetryable(Object.assign(new Error(String(status)), { status })), true, String(status));
  }
});

test('isRetryable: 4xx hard errors not retryable', () => {
  for (const status of [400, 401, 403, 404]) {
    assert.equal(isRetryable(Object.assign(new Error('hard'), { status })), false, String(status));
  }
});

test('isRetryable: keyword based timeout / rate limit', () => {
  assert.equal(isRetryable(new Error('codex turn timed out after 180000ms')), true);
  assert.equal(isRetryable(new Error('rate limit hit, slow down')), true);
  assert.equal(isRetryable(new Error('overloaded server')), true);
});

test('isRetryable: explicit non-retryable turn timeout', () => {
  const err = new Error('claude-code turn timed out after 7200000ms');
  err.code = 'EA2A_TURN_TIMEOUT';
  err.retryable = false;
  assert.equal(isRetryable(err), false);
});

test('isRetryable: auth keywords not retryable', () => {
  assert.equal(isRetryable(new Error('Unauthorized')), false);
  assert.equal(isRetryable(new Error('invalid api key')), false);
  assert.equal(isRetryable(new Error('Permission denied')), false);
});

test('isRetryable: policy blocks are not retryable', () => {
  assert.equal(isRetryable(new Error('codex response failed (cyber_policy): blocked')), false);
  assert.equal(isRetryable(new Error('This content was flagged for possible cybersecurity risk.')), false);
});

test('runWithRetry: succeeds after transient failure', async () => {
  let calls = 0;
  const result = await runWithRetry({
    attempts: 3, baseMs: 1, capMs: 5,
    fn: async () => {
      calls += 1;
      if (calls < 2) {
        const e = new Error('boom'); e.code = 'ECONNRESET'; throw e;
      }
      return 'ok';
    },
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

test('runWithRetry: stops on hard error', async () => {
  let calls = 0;
  await assert.rejects(
    runWithRetry({
      attempts: 5, baseMs: 1, capMs: 5,
      fn: async () => {
        calls += 1;
        const e = new Error('auth fail'); e.status = 401; throw e;
      },
    }),
    /auth fail/,
  );
  assert.equal(calls, 1);
});

test('runWithRetry: exhausts attempts then throws', async () => {
  let calls = 0;
  await assert.rejects(
    runWithRetry({
      attempts: 2, baseMs: 1, capMs: 5,
      fn: async () => {
        calls += 1;
        const e = new Error('still failing'); e.code = 'ETIMEDOUT'; throw e;
      },
    }),
    /still failing/,
  );
  assert.equal(calls, 3); // initial + 2 retries
});

test('backoffDelay: capped + monotonic up to cap', () => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const d = backoffDelay({ attempt, baseMs: 100, capMs: 1500 });
    assert.ok(d >= 100, `attempt=${attempt} got ${d}`);
    assert.ok(d <= 1500, `attempt=${attempt} got ${d}`);
  }
});
