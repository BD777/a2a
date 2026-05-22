import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitForFeishu, splitForFeishuMarkdown } from '../src/feishu/text-chunk.js';

test('returns empty array for empty input', () => {
  assert.deepEqual(splitForFeishu(''), []);
  assert.deepEqual(splitForFeishu('   '), []);
  assert.deepEqual(splitForFeishu(null), []);
});

test('returns single chunk when below limit', () => {
  const out = splitForFeishu('hello world', { limit: 100 });
  assert.deepEqual(out, ['hello world']);
});

test('splits long text and annotates parts', () => {
  const body = ('para1 sentence.\n\n' + 'x'.repeat(400) + '\n\n' + 'tail').padEnd(900, '.');
  const out = splitForFeishu(body, { limit: 200 });
  assert.ok(out.length >= 2);
  for (let i = 0; i < out.length; i += 1) {
    assert.match(out[i], new RegExp(`\\[part ${i + 1}/${out.length}\\]$`));
  }
  // joined chunks (sans the markers) should still contain meaningful parts
  const joined = out.map((c) => c.replace(/\n\n\[part \d+\/\d+\]$/, '')).join(' ');
  assert.ok(joined.includes('para1 sentence.'));
  assert.ok(joined.includes('tail'));
});

test('prefers paragraph boundary when available', () => {
  const text = 'first chunk content goes here.\n\nsecond chunk content goes here too.';
  const out = splitForFeishu(text, { limit: 40 });
  // first chunk should end at paragraph break
  assert.match(out[0], /first chunk content goes here\./);
  assert.match(out[1], /second chunk content goes here too\./);
});

test('falls back to hard cut when no boundary near limit', () => {
  const body = 'a'.repeat(500);
  const out = splitForFeishu(body, { limit: 100 });
  assert.equal(out.length, 5);
  for (const chunk of out) {
    // raw chunk + " \n\n[part x/y]" suffix
    assert.ok(chunk.length <= 100 + 20, `chunk too long: ${chunk.length}`);
  }
});

test('splitForFeishuMarkdown returns single chunk when within byte limit', () => {
  const out = splitForFeishuMarkdown('hello world', { byteLimit: 100 });
  assert.deepEqual(out, ['hello world']);
});

test('splitForFeishuMarkdown counts bytes for CJK content', () => {
  // Each CJK char is 3 bytes. 50 chars = 150 bytes.
  const body = '中'.repeat(50);
  const out = splitForFeishuMarkdown(body, { byteLimit: 60 });
  assert.ok(out.length >= 3, `expected >=3 chunks for 150 bytes at 60-byte limit, got ${out.length}`);
  for (const chunk of out) {
    assert.ok(Buffer.byteLength(chunk, 'utf8') <= 60, `chunk over byte limit: ${Buffer.byteLength(chunk, 'utf8')}`);
  }
  assert.equal(out.join(''), body);
});

test('splitForFeishuMarkdown rebalances open code fences across chunks', () => {
  const body = 'prelude text.\n\n```js\n' + 'console.log("x");\n'.repeat(40) + '```\n\ntail';
  const out = splitForFeishuMarkdown(body, { byteLimit: 200 });
  assert.ok(out.length >= 2);
  for (const chunk of out) {
    const fences = (chunk.match(/```/g) || []).length;
    assert.equal(fences % 2, 0, `chunk has unbalanced fences: ${chunk}`);
  }
  // The original code lines should still be present somewhere across chunks
  const joined = out.join('\n');
  assert.ok(joined.includes('console.log("x");'));
});

test('splitForFeishuMarkdown emits empty array for empty input', () => {
  assert.deepEqual(splitForFeishuMarkdown(''), []);
  assert.deepEqual(splitForFeishuMarkdown('   '), []);
  assert.deepEqual(splitForFeishuMarkdown(null), []);
});
