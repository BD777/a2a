import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamingCardController } from '../src/feishu/streaming-card-controller.js';
import {
  STREAMING_BODY_ELEMENT_ID,
  STREAMING_THINKING_ELEMENT_ID,
} from '../src/feishu/cards.js';

function makeClients() {
  return {
    contentCalls: [],
    replaceCalls: [],
    deleteMessageCalls: [],
    mintCalls: 0,
    async updateCardElementContent(appId, cardId, elementId, content, sequence) {
      this.contentCalls.push({ appId, cardId, elementId, content, sequence });
    },
    async replaceCard(appId, cardId, cardJson, sequence) {
      this.replaceCalls.push({ appId, cardId, cardJson, sequence });
    },
    async deleteMessage(appId, messageId) {
      this.deleteMessageCalls.push({ appId, messageId });
    },
  };
}

function makeController(overrides = {}) {
  const clients = overrides.clients || makeClients();
  const cardMinter = overrides.cardMinter || (async () => {
    clients.mintCalls += 1;
    return { appId: 'app1', cardId: 'card1', messageId: 'msg1' };
  });
  const ctrl = new StreamingCardController({
    cardMinter,
    cliId: 'claude-code',
    round: 1,
    template: 'blue',
    clients,
    logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
    textMs: 50,
    thinkMs: 80,
    textMinChars: 0,
    byteLimit: overrides.byteLimit || 200,
    fallback: overrides.fallback,
  });
  return { ctrl, clients };
}

function tick(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test('appendText flushes after textMs and serializes sequence', async () => {
  const { ctrl, clients } = makeController();
  ctrl.appendText('hello ');
  ctrl.appendText('world');
  await tick(80);
  assert.equal(clients.contentCalls.length, 1);
  assert.equal(clients.contentCalls[0].content, 'hello world');
  assert.equal(clients.contentCalls[0].elementId, STREAMING_BODY_ELEMENT_ID);
  assert.equal(clients.contentCalls[0].sequence, 1);

  ctrl.appendText('!');
  await tick(80);
  assert.equal(clients.contentCalls.length, 2);
  assert.equal(clients.contentCalls[1].content, 'hello world!');
  assert.equal(clients.contentCalls[1].sequence, 2);

  await ctrl.finalize({ content: 'hello world!' });
});

test('setThinking and appendText flush independently and never share sequence', async () => {
  const { ctrl, clients } = makeController();
  ctrl.appendText('chunk');
  ctrl.setThinking('reasoning step');
  await tick(150);
  const thinkingCalls = clients.contentCalls.filter((c) => c.elementId === STREAMING_THINKING_ELEMENT_ID);
  const bodyCalls = clients.contentCalls.filter((c) => c.elementId === STREAMING_BODY_ELEMENT_ID);
  assert.equal(thinkingCalls.length, 1);
  assert.equal(bodyCalls.length, 1);
  const sequences = clients.contentCalls.map((c) => c.sequence).sort((a, b) => a - b);
  const unique = new Set(sequences);
  assert.equal(unique.size, sequences.length, 'sequences must be unique across elements');

  await ctrl.finalize({ content: 'chunk' });
});

test('appendActivity streams tool progress through thinking panel', async () => {
  const { ctrl, clients } = makeController();
  await ctrl.start();
  ctrl.appendActivity('- Running Bash: `internal-cli search query`');
  ctrl.appendActivity('- Tool result: 12 messages found');
  await tick(100);

  const thinkingCalls = clients.contentCalls.filter((c) => c.elementId === STREAMING_THINKING_ELEMENT_ID);
  assert.equal(thinkingCalls.length, 1);
  assert.match(thinkingCalls[0].content, /\*\*Activity\*\*/);
  assert.match(thinkingCalls[0].content, /internal-cli search query/);
  assert.match(thinkingCalls[0].content, /12 messages found/);
});

test('finalize cancels timers and writes final card', async () => {
  const { ctrl, clients } = makeController();
  ctrl.appendText('partial ');
  await tick(80);
  await ctrl.finalize({ content: 'final response' });
  assert.equal(clients.replaceCalls.length, 1);
  const finalCard = clients.replaceCalls[0].cardJson;
  assert.equal(finalCard.header.template, 'blue');
  const bodyEl = finalCard.body.elements.find((el) => el.element_id === STREAMING_BODY_ELEMENT_ID);
  assert.ok(bodyEl);
  assert.equal(bodyEl.content, 'final response');

  // a late append after finalize must not produce more API calls
  const before = clients.contentCalls.length;
  ctrl.appendText('zombie');
  await tick(80);
  assert.equal(clients.contentCalls.length, before);
});

test('finalize deletes eager empty card instead of posting quiet turn', async () => {
  const { ctrl, clients } = makeController();
  await ctrl.start();
  const result = await ctrl.finalize({ content: '' });

  assert.deepEqual(clients.deleteMessageCalls, [{ appId: 'app1', messageId: 'msg1' }]);
  assert.equal(clients.replaceCalls.length, 0);
  assert.equal(result.messageId, 'msg1');
  assert.equal(result.suppressed, true);
});

test('fail paints red header and includes partial body', async () => {
  const { ctrl, clients } = makeController();
  ctrl.appendText('half-written');
  await tick(80);
  await ctrl.fail(new Error('relay timeout'));
  assert.equal(clients.replaceCalls.length, 1);
  const failedCard = clients.replaceCalls[0].cardJson;
  assert.equal(failedCard.header.template, 'red');
  assert.match(failedCard.header.title.content, /failed/);
  const elements = failedCard.body.elements;
  const errorElement = elements[elements.length - 1];
  assert.match(errorElement.content, /relay timeout/);
});

test('fail returns message id and preserves policy diagnostic within limit', async () => {
  const { ctrl, clients } = makeController({ byteLimit: 1000 });
  await ctrl.start();
  const message = 'codex response failed (cyber_policy): This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. To get authorized for security work, join the Trusted Access for Cyber program: https://chatgpt.com/cyber';
  const result = await ctrl.fail(new Error(message));

  assert.deepEqual(result, { messageId: 'msg1', failed: true });
  const failedCard = clients.replaceCalls[0].cardJson;
  const errorElement = failedCard.body.elements.at(-1);
  assert.match(errorElement.content, /cyber_policy/);
  assert.match(errorElement.content, /https:\/\/chatgpt\.com\/cyber/);
});

test('overflow defers to fallback and stops streaming', async () => {
  const fallbackCalls = [];
  const fallback = async ({ content, round }) => {
    fallbackCalls.push({ content, round });
    return 'fallback-msg';
  };
  const { ctrl, clients } = makeController({ fallback });
  await ctrl.start();
  const big = 'x'.repeat(300);
  const result = await ctrl.finalize({ content: big + 'overflow tail' });

  assert.equal(fallbackCalls.length, 1);
  assert.match(fallbackCalls[0].content, /overflow tail$/);
  assert.deepEqual(clients.deleteMessageCalls, [{ appId: 'app1', messageId: 'msg1' }]);
  assert.equal(clients.replaceCalls.length, 0);
  assert.equal(result.messageId, 'fallback-msg');
  assert.equal(result.suppressed, true);
  assert.equal(result.overflow, true);
});

test('finalize is idempotent', async () => {
  const { ctrl, clients } = makeController();
  ctrl.appendText('one');
  await tick(80);
  await ctrl.finalize({ content: 'one' });
  await ctrl.finalize({ content: 'one' });
  assert.equal(clients.replaceCalls.length, 1);
});

test('lazy mint: empty turn never creates a card', async () => {
  const fallbackCalls = [];
  const fallback = async () => { fallbackCalls.push(true); return 'fallback-msg'; };
  const { ctrl, clients } = makeController({ fallback });
  // No appendText / setText calls.
  const result = await ctrl.finalize({ content: '' });
  assert.equal(clients.mintCalls, 0);
  assert.equal(clients.replaceCalls.length, 0);
  assert.equal(clients.contentCalls.length, 0);
  assert.equal(fallbackCalls.length, 0);
  assert.equal(result, null);
});

test('lazy mint: non-empty turn that never flushed falls back to publishAgent', async () => {
  const fallbackCalls = [];
  const fallback = async ({ content }) => { fallbackCalls.push(content); return 'fallback-msg'; };
  // textMinChars 50 means deltas under 50 chars never reach the API.
  const clients = makeClients();
  const ctrl = new StreamingCardController({
    cardMinter: async () => {
      clients.mintCalls += 1;
      return { appId: 'app1', cardId: 'card1', messageId: 'msg1' };
    },
    cliId: 'claude-code',
    round: 2,
    template: 'blue',
    clients,
    logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
    textMs: 50,
    thinkMs: 80,
    textMinChars: 50,
    byteLimit: 200,
    fallback,
  });
  ctrl.appendText('short reply');
  await tick(80);
  const result = await ctrl.finalize({ content: 'short reply' });
  assert.equal(clients.mintCalls, 0, 'card must not be minted when no flush ran');
  assert.equal(clients.replaceCalls.length, 0);
  assert.equal(fallbackCalls.length, 1);
  assert.equal(fallbackCalls[0], 'short reply');
  assert.equal(result.messageId, 'fallback-msg');
});

test('lazy mint: card is minted on first flush, not on construction', async () => {
  const { ctrl, clients } = makeController();
  assert.equal(clients.mintCalls, 0, 'no mint on construction');
  ctrl.appendText('hello');
  await tick(80);
  assert.equal(clients.mintCalls, 1, 'mint happens on first flush');
  ctrl.appendText(' world');
  await tick(80);
  assert.equal(clients.mintCalls, 1, 'mint is memoized');
  await ctrl.finalize({ content: 'hello world' });
});

test('start mints the card before any text arrives', async () => {
  const { ctrl, clients } = makeController();
  const minted = await ctrl.start();
  assert.deepEqual(minted, { appId: 'app1', cardId: 'card1', messageId: 'msg1' });
  assert.equal(ctrl.messageId, 'msg1');
  assert.equal(clients.mintCalls, 1);

  ctrl.appendText('hello after start');
  await tick(80);
  assert.equal(clients.mintCalls, 1, 'start and flush share the same minted card');
  assert.equal(clients.contentCalls.length, 1);
  await ctrl.finalize({ content: 'hello after start' });
});

test('mint failure: finalize falls back to publishAgent without throwing', async () => {
  const fallbackCalls = [];
  const fallback = async ({ content }) => { fallbackCalls.push(content); return 'fallback-msg'; };
  const clients = makeClients();
  const failingMinter = async () => { throw new Error('cardkit scope missing'); };
  const ctrl = new StreamingCardController({
    cardMinter: failingMinter,
    cliId: 'claude-code',
    round: 3,
    template: 'blue',
    clients,
    logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
    textMs: 50,
    thinkMs: 80,
    textMinChars: 0,
    byteLimit: 200,
    fallback,
  });
  ctrl.appendText('hello world this is content');
  await tick(80);
  // flush attempted to mint and failed; no API call.
  assert.equal(clients.contentCalls.length, 0);
  const result = await ctrl.finalize({ content: 'hello world this is content' });
  assert.equal(clients.replaceCalls.length, 0);
  assert.equal(fallbackCalls.length, 1);
  assert.equal(result.messageId, 'fallback-msg');
});

test('fail before mint: no red card is posted', async () => {
  const { ctrl, clients } = makeController();
  await ctrl.fail(new Error('cancelled before any output'));
  assert.equal(clients.mintCalls, 0);
  assert.equal(clients.replaceCalls.length, 0);
});
