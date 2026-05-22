import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClaudeContent } from '../src/runtime/claude-agent-runtime.js';

test('buildClaudeContent embeds downloaded images as base64 image blocks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-claude-image-'));
  const imagePath = join(dir, 'image.png');
  writeFileSync(imagePath, Buffer.from('89504e470d0a1a0a0000000d', 'hex'));
  try {
    const content = buildClaudeContent('look', [{ kind: 'image', localPath: imagePath, mimeType: 'image/png' }]);
    assert.equal(Array.isArray(content), true);
    assert.deepEqual(content[0], { type: 'text', text: 'look' });
    assert.equal(content[1].type, 'image');
    assert.equal(content[1].source.type, 'base64');
    assert.equal(content[1].source.media_type, 'image/png');
    assert.equal(content[1].source.data, Buffer.from('89504e470d0a1a0a0000000d', 'hex').toString('base64'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
