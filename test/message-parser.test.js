import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  eventRoot,
  isBotSender,
  senderId,
  extractEventText,
  extractEventParts,
  collectCardText,
} from '../src/feishu/message-parser.js';

test('eventRoot prefers root_id, falls back to message_id', () => {
  assert.equal(eventRoot({ message_id: 'm1' }), 'm1');
  assert.equal(eventRoot({ message_id: 'm1', root_id: 'r1' }), 'r1');
});

test('isBotSender flags app/bot, ignores user', () => {
  assert.equal(isBotSender({ sender_type: 'app' }), true);
  assert.equal(isBotSender({ sender_type: 'bot' }), true);
  assert.equal(isBotSender({ sender_type: 'user' }), false);
  assert.equal(isBotSender(null), false);
});

test('senderId picks open_id then user_id then app_id', () => {
  assert.equal(senderId({ sender_id: { open_id: 'a', user_id: 'b' } }), 'a');
  assert.equal(senderId({ sender_id: { user_id: 'b' } }), 'b');
  assert.equal(senderId({ sender_id: { app_id: 'c' } }), 'c');
  assert.equal(senderId({}), '');
});

test('extractEventText handles text + mentions', () => {
  const text = extractEventText({
    message_type: 'text',
    content: JSON.stringify({ text: '@_user_1 hello' }),
    mentions: [{ key: '@_user_1', name: 'Alice' }],
  });
  assert.equal(text, '@Alice hello');
});

test('extractEventText handles post messages', () => {
  const text = extractEventText({
    message_type: 'post',
    content: JSON.stringify({
      zh_cn: {
        content: [
          [{ tag: 'text', text: 'line1 ' }, { tag: 'at', user_name: 'Bob' }],
          [{ tag: 'text', text: 'line2' }],
        ],
      },
    }),
  });
  assert.equal(text, 'line1 @Bob\nline2');
});

test('extractEventText handles image / file types', () => {
  assert.equal(extractEventText({ message_type: 'image', content: '{}' }), '[image]');
  assert.equal(
    extractEventText({ message_type: 'file', content: JSON.stringify({ file_name: 'a.pdf' }) }),
    '[file:a.pdf]',
  );
});

test('extractEventParts extracts image resources from image and post messages', () => {
  const direct = extractEventParts({
    message_id: 'om_1',
    message_type: 'image',
    content: JSON.stringify({ image_key: 'img_v2_123' }),
  });
  assert.equal(direct.text, '[image]');
  assert.deepEqual(direct.attachments, [{
    kind: 'image',
    resourceType: 'image',
    fileKey: 'img_v2_123',
    messageId: 'om_1',
    source: 'message',
  }]);

  const post = extractEventParts({
    message_id: 'om_2',
    message_type: 'post',
    content: JSON.stringify({
      zh_cn: { content: [[{ tag: 'text', text: 'see ' }, { tag: 'img', image_key: 'img_v2_456' }]] },
    }),
  });
  assert.equal(post.text, 'see [image]');
  assert.equal(post.attachments[0].fileKey, 'img_v2_456');
  assert.equal(post.attachments[0].source, 'post');
});

test('collectCardText walks nested elements', () => {
  const out = collectCardText({
    body: {
      elements: [
        { tag: 'markdown', content: 'hi' },
        { tag: 'div', elements: [{ tag: 'plain_text', text: 'there' }] },
      ],
    },
  });
  assert.deepEqual(out, ['hi', 'there']);
});
