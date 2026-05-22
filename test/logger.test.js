import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../src/logger.js';

function withTmpLog(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-log-'));
  const path = join(dir, 'a2a.log');
  try { return fn(path); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('text format writes ISO timestamp + level prefix', () => {
  withTmpLog((path) => {
    const log = createLogger(path, { format: 'text', level: 'debug' });
    log.info('hello', { a: 1 });
    const content = readFileSync(path, 'utf8');
    assert.match(content, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.match(content, / INFO hello \{"a":1\}/);
  });
});

test('json format emits one JSON object per line', () => {
  withTmpLog((path) => {
    const log = createLogger(path, { format: 'json', level: 'info' });
    log.info({ event: 'turn_done', sessionId: 's1', durationMs: 42 });
    log.warn('something happened');
    log.error(new Error('boom'));

    const lines = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines.length, 3);

    assert.equal(lines[0].level, 'info');
    assert.equal(lines[0].event, 'turn_done');
    assert.equal(lines[0].sessionId, 's1');
    assert.equal(lines[0].durationMs, 42);

    assert.equal(lines[1].level, 'warn');
    assert.equal(lines[1].msg, 'something happened');

    assert.equal(lines[2].level, 'error');
    assert.equal(lines[2].err.message, 'boom');
    assert.ok(lines[2].err.stack);
  });
});

test('min level filters debug', () => {
  withTmpLog((path) => {
    const log = createLogger(path, { format: 'text', level: 'info' });
    log.debug('hidden');
    log.info('visible');
    const content = readFileSync(path, 'utf8');
    assert.doesNotMatch(content, /hidden/);
    assert.match(content, /visible/);
  });
});
