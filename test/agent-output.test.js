import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  couldBecomeInternalPromptLeak,
  isInternalPromptLeak,
  parseAgentOutput,
} from '../src/protocol/agent-output.js';

test('parseAgentOutput suppresses internal prompt echoes', () => {
  const leaked = `Human: New user messages since your last turn:
<new_user_messages>
private user text
</new_user_messages>`;
  assert.equal(isInternalPromptLeak(leaked), true);
  assert.equal(parseAgentOutput(leaked).content, '');
});

test('prompt leak prefix detection can hold early streaming fragments', () => {
  assert.equal(couldBecomeInternalPromptLeak('Human:'), true);
  assert.equal(couldBecomeInternalPromptLeak('Human: New user'), true);
  assert.equal(couldBecomeInternalPromptLeak('Human: I agree'), false);
});

test('parseAgentOutput preserves normal responses', () => {
  assert.equal(parseAgentOutput('Human: I agree with the plan.').content, 'Human: I agree with the plan.');
  assert.equal(parseAgentOutput('正常回复').content, '正常回复');
});
