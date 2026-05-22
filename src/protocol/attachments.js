export function formatContentWithAttachments(text, attachments = []) {
  const notes = formatAttachmentNotes(attachments);
  return [text || '', notes].filter(Boolean).join('\n');
}

export function formatAttachmentNotes(attachments = []) {
  const list = (Array.isArray(attachments) ? attachments : [])
    .filter((item) => item && typeof item === 'object');
  if (list.length === 0) return '';
  const lines = list.map((item, index) => {
    const kind = item.kind || 'attachment';
    const messageId = item.messageId ? `message=${item.messageId}` : 'message=unknown';
    const status = item.localPath
      ? 'available as visual input'
      : item.error
        ? `unavailable: ${item.error}`
        : 'pending download';
    return `- ${kind} ${index + 1}: ${status} (${messageId})`;
  });
  return `Attachments:\n${lines.join('\n')}`;
}
