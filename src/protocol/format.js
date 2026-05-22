export function formatTime(value, timeZone) {
  const ts = Number(value || 0);
  if (!Number.isFinite(ts) || ts <= 0) return 'unknown-time';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ts));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day} ${byType.hour}:${byType.minute}:${byType.second} ${timeZone}`;
}

export function formatMessageLine({ time, sender, msgType, messageId, text }) {
  const meta = [
    msgType ? `type=${msgType}` : '',
    messageId ? `id=${messageId}` : '',
  ].filter(Boolean).join(', ');
  const suffix = meta ? ` (${meta})` : '';
  return `[${time || 'unknown-time'}] ${sender || 'unknown-sender'}${suffix}:\n${text || ''}`;
}
