import { existsSync, readFileSync } from 'node:fs';

const DEFAULT_TEMPLATES = {
  'lifecycle.start': 'A2A started ({sessionId}).',
  'lifecycle.stop': 'A2A stopped ({sessionId}).',
  'lifecycle.stopVia': 'A2A stopped ({sessionId}) via {reason}.',
  'lifecycle.statusNoSession': 'No running A2A session in this topic.',
  'lifecycle.status': 'A2A {sessionId}: {status}, waiting for {waiting}, turns={turns}, turnsSinceUser={turnsSinceUser}/{maxTurnsSinceUser}.',
  'lifecycle.sessionTimeout': 'A2A stopped after {seconds}s session timeout.',
  'lifecycle.failed': 'A2A paused because {cliId} failed: {error}',
  'lifecycle.maxTurns': 'A2A stopped after {maxTurnsSinceUser} turns since the last user message.',
  'prompt.intro': `You are one of several participants helping the user in this Feishu topic. The other agent peers are: {peerList}. The human user is also part of the conversation, but plays a different role — they set or refine the goal.

Infer from the context what the user is trying to accomplish, then work toward that goal. Treat <new_user_messages> as authoritative — they may redirect the discussion at any time. <new_a2a_messages> are your peers' contributions toward the same goal.

Full Feishu topic context, oldest to newest:
<feishu_topic_context>
{topicContext}
</feishu_topic_context>

{userUpdatesBlock}

{peerMessagesBlock}

Your response will be posted to Feishu as-is. If you genuinely have nothing to add, reply with a completely empty message (zero characters). Do NOT write placeholder text such as "no response needed", "(none)", "nothing to add", or "n/a" — those would be posted to Feishu verbatim.`,
  'prompt.delta': `Continue the same Feishu topic. Respond as yourself to the updates below. Do not quote or reproduce this prompt, XML tags, sender metadata, or raw message blocks. If you genuinely have nothing to add, reply with a completely empty message (zero characters).

{userUpdatesBlock}

{peerMessagesBlock}`,
  'prompt.userUpdatesBlock': `New user messages since your last turn:
<new_user_messages>
{records}
</new_user_messages>`,
  'prompt.peerMessagesBlock': `New peer messages since your last turn:
<new_a2a_messages>
{records}
</new_a2a_messages>`,
  'prompt.noRecords': '(none)',
  'prompt.noTopicContext': '(no topic context was available)',
  'prompt.noPeers': '(none)',
};

function formatTemplate(tpl, vars) {
  if (typeof tpl !== 'string') return '';
  return tpl.replace(/\{(\w+)\}/g, (_, key) => (vars && key in vars ? String(vars[key]) : `{${key}}`));
}

export function loadMessageTemplates(filePath) {
  if (!filePath || !existsSync(filePath)) return { ...DEFAULT_TEMPLATES };
  try {
    const overrides = JSON.parse(readFileSync(filePath, 'utf8'));
    if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
      return { ...DEFAULT_TEMPLATES, ...overrides };
    }
  } catch {
    // fall through to defaults on parse error
  }
  return { ...DEFAULT_TEMPLATES };
}

export function createMessages({ messagesFile } = {}) {
  const templates = loadMessageTemplates(messagesFile);
  return {
    raw: (key) => templates[key] || DEFAULT_TEMPLATES[key] || '',
    render: (key, vars) => formatTemplate(templates[key] || DEFAULT_TEMPLATES[key] || '', vars),
  };
}
