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

export function parseAgentOutput(value) {
  const text = typeof value === 'string' ? value.trim() : JSON.stringify(value ?? '');
  const content = isEmptyPlaceholder(text) ? '' : text;
  return {
    content,
    raw: value,
  };
}
