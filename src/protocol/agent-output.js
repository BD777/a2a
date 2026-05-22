const EMPTY_PLACEHOLDERS = new Set([
  'no response needed',
  'no response required',
  'no response',
  'no further response',
  'no further response needed',
  'no further comment',
  'no comment',
  'nothing to add',
  'nothing further',
  'nothing more to add',
  'none',
  'n/a',
]);

const PLACEHOLDER_LEAD = /^[\s*_`"'(\[<-]+/;
const PLACEHOLDER_TRAIL = /[\s*_`"')\]>.!?,;:-]+$/;

const INTERNAL_PROMPT_PREFIXES = [
  'human: new user messages since your last turn:',
  'new user messages since your last turn:',
  'human: new peer messages since your last turn:',
  'new peer messages since your last turn:',
  'human: full feishu topic context, oldest to newest:',
  'full feishu topic context, oldest to newest:',
  'human: you are one of several participants helping the user',
  'you are one of several participants helping the user',
  '<new_user_messages>',
  '<new_a2a_messages>',
  '<feishu_topic_context>',
];

const INTERNAL_PROMPT_MARKERS = [
  '<new_user_messages>',
  '</new_user_messages>',
  '<new_a2a_messages>',
  '</new_a2a_messages>',
  '<feishu_topic_context>',
  '</feishu_topic_context>',
];

export function isEmptyPlaceholder(text) {
  if (typeof text !== 'string') return !text;
  const stripped = text
    .trim()
    .replace(PLACEHOLDER_LEAD, '')
    .replace(PLACEHOLDER_TRAIL, '')
    .toLowerCase();
  if (!stripped) return true;
  return EMPTY_PLACEHOLDERS.has(stripped);
}

export function isInternalPromptLeak(text) {
  if (typeof text !== 'string') return false;
  const normalized = normalizePromptText(text);
  if (!normalized) return false;
  if (INTERNAL_PROMPT_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return true;
  return INTERNAL_PROMPT_MARKERS.some((marker) => normalized.includes(marker));
}

export function couldBecomeInternalPromptLeak(text) {
  if (typeof text !== 'string') return false;
  const normalized = normalizePromptText(text);
  if (!normalized) return true;
  return INTERNAL_PROMPT_PREFIXES.some((prefix) => prefix.startsWith(normalized));
}

export function parseAgentOutput(value) {
  const text = typeof value === 'string' ? value.trim() : JSON.stringify(value ?? '');
  const content = isEmptyPlaceholder(text) || isInternalPromptLeak(text) ? '' : text;
  return {
    content,
    raw: value,
  };
}

function normalizePromptText(text) {
  return String(text || '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}
