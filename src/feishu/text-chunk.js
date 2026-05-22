const DEFAULT_LIMIT = 3500;
const DEFAULT_BYTE_LIMIT = 4500;
const FENCE = '```';

export function splitForFeishu(text, { limit = DEFAULT_LIMIT } = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  if (trimmed.length <= limit) return [trimmed];

  const chunks = [];
  let remaining = trimmed;
  while (remaining.length > limit) {
    const slice = remaining.slice(0, limit);
    let cut = lastIndexOfAny(slice, ['\n\n', '\n', '. ', '。', '! ', '? ']);
    if (cut < Math.floor(limit * 0.5)) cut = limit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);

  const total = chunks.length;
  return chunks.map((part, idx) => `${part}\n\n[part ${idx + 1}/${total}]`);
}

export function splitForFeishuMarkdown(text, { byteLimit = DEFAULT_BYTE_LIMIT } = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  if (utf8ByteLength(trimmed) <= byteLimit) return [trimmed];

  const raw = [];
  let remaining = trimmed;
  while (utf8ByteLength(remaining) > byteLimit) {
    const charCut = sliceByByteLimit(remaining, byteLimit);
    const slice = remaining.slice(0, charCut);
    let cut = lastIndexOfAny(slice, ['\n\n', '\n', '. ', '。', '! ', '? ']);
    if (cut < Math.floor(charCut * 0.5)) cut = charCut;
    raw.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) raw.push(remaining);

  return balanceFences(raw);
}

function balanceFences(chunks) {
  let carryFence = '';
  return chunks.map((chunk, idx) => {
    let body = carryFence ? `${carryFence}\n${chunk}` : chunk;
    const count = (body.match(/```/g) || []).length;
    const isLast = idx === chunks.length - 1;
    if (count % 2 === 1) {
      body = `${body}\n${FENCE}`;
      carryFence = FENCE;
    } else {
      carryFence = '';
    }
    if (isLast && carryFence) {
      body = `${body}\n${FENCE}`;
    }
    return body;
  });
}

function sliceByByteLimit(text, byteLimit) {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const charBytes = utf8ByteLength(text[i]);
    if (bytes + charBytes > byteLimit) return i || 1;
    bytes += charBytes;
  }
  return text.length;
}

function utf8ByteLength(str) {
  return Buffer.byteLength(str, 'utf8');
}

function lastIndexOfAny(haystack, needles) {
  let best = -1;
  for (const needle of needles) {
    const at = haystack.lastIndexOf(needle);
    if (at > best) best = at + needle.length;
  }
  return best;
}
