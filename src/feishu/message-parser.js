import { formatMessageLine, formatTime } from '../protocol/format.js';
import { formatContentWithAttachments } from '../protocol/attachments.js';

export function eventRoot(message) {
  return message.root_id || message.message_id;
}

export function isBotSender(sender) {
  const type = sender?.sender_type;
  return type === 'app' || type === 'bot';
}

export function senderId(sender) {
  const id = sender?.sender_id || {};
  return id.open_id || id.user_id || id.union_id || id.app_id || id.id || '';
}

export function collectCardText(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) collectCardText(item, out);
    return out;
  }
  if (['markdown', 'md', 'plain_text', 'text'].includes(value.tag)) {
    if (typeof value.content === 'string') out.push(value.content);
    if (typeof value.text === 'string') out.push(value.text);
  }
  for (const key of ['body', 'elements', 'actions', 'header', 'title']) {
    collectCardText(value[key], out);
  }
  return out;
}

export function extractEventText(message) {
  return extractEventParts(message).text;
}

export function extractEventParts(message) {
  try {
    const content = JSON.parse(message.content || '{}');
    if (message.message_type === 'text') {
      let text = content.text || '';
      for (const mention of message.mentions || []) {
        if (mention.key && mention.name) text = text.replaceAll(mention.key, `@${mention.name}`);
      }
      return { text: text.trim(), attachments: [] };
    }
    if (message.message_type === 'post') {
      const attachments = [];
      const root = content.zh_cn || content.en_us || content;
      const blocks = Array.isArray(root.content) ? root.content : [];
      const text = blocks
        .map((block) => (Array.isArray(block) ? block : [block])
          .map((node) => {
            if (node.tag === 'text' || node.tag === 'md') return node.text || '';
            if (node.tag === 'a') {
              const text = node.text || '';
              const href = node.href || '';
              if (text && href && text !== href) return `[${text}](${href})`;
              return text || href || '';
            }
            if (node.tag === 'at') return `@${node.user_name || 'unknown'}`;
            if (node.tag === 'img') {
              const image = imageAttachment(message, node.image_key || node.file_key || node.key, 'post');
              if (image) attachments.push(image);
              return '[image]';
            }
            if (node.tag === 'file') {
              const file = fileAttachment(message, node.file_key, node.file_name, 'post');
              if (file) attachments.push(file);
              return `[file:${node.file_name || node.file_key || 'unknown'}]`;
            }
            if (node.tag === 'emotion') return node.emoji_type ? `:${node.emoji_type}:` : '';
            if (node.tag === 'code_inline') return node.text ? `\`${node.text}\`` : '';
            return '';
          })
          .join(''))
        .join('\n')
        .trim();
      return { text, attachments };
    }
    if (message.message_type === 'interactive') {
      const unwrapped = unwrapUserDslContent(message.content);
      const parsed = unwrapped ? JSON.parse(unwrapped) : content;
      const title = parsed.header?.title?.content || parsed.title || '';
      const cardText = collectCardText(parsed).filter(Boolean).join('\n').trim();
      return { text: [title, cardText].filter(Boolean).join('\n').trim(), attachments: [] };
    }
    if (message.message_type === 'image') {
      const attachment = imageAttachment(message, content.image_key || content.file_key || content.key, 'message');
      return { text: '[image]', attachments: attachment ? [attachment] : [] };
    }
    if (message.message_type === 'file') {
      const attachment = fileAttachment(message, content.file_key, content.file_name, 'message');
      return {
        text: `[file:${content.file_name || content.file_key || 'unknown'}]`,
        attachments: attachment ? [attachment] : [],
      };
    }
  } catch {
    // Fall through to raw content.
  }
  return { text: String(message.content || '').trim(), attachments: [] };
}

export function unwrapUserDslContent(rawContent) {
  try {
    const outer = JSON.parse(rawContent || '{}');
    if (typeof outer?.user_dsl !== 'string') return null;
    const inner = JSON.parse(outer.user_dsl);
    if (!inner || typeof inner !== 'object') return null;
    if (!inner.body && !inner.elements && !inner.header) return null;
    return JSON.stringify(inner);
  } catch {
    return null;
  }
}

export function parseApiMessage(message) {
  const msgType = message.msg_type || message.message_type || 'text';
  const rawContent = message.body?.content || message.content || '';
  const parts = extractEventParts({
    message_id: message.message_id,
    message_type: msgType,
    content: rawContent,
    mentions: message.mentions || [],
  });
  return {
    messageId: message.message_id,
    rootId: message.root_id || '',
    threadId: message.thread_id || '',
    msgType,
    content: parts.text,
    attachments: parts.attachments,
    createTime: Number(message.create_time || 0) || Date.now(),
    sender: message.sender || {},
  };
}

export function formatTopicMessages(messages, { timeZone, messageCharLimit, senderLabel }) {
  return messages
    .filter((message) => message.content)
    .map((message) => formatMessageLine({
      time: formatTime(message.createTime, timeZone),
      sender: senderLabel(message),
      msgType: message.msgType,
      messageId: message.messageId,
      text: formatContentWithAttachments(message.content, message.attachments).slice(0, messageCharLimit),
    }))
    .join('\n\n');
}

function imageAttachment(message, fileKey, source) {
  if (!fileKey) return null;
  return {
    kind: 'image',
    resourceType: 'image',
    fileKey: String(fileKey),
    messageId: message.message_id || '',
    source,
  };
}

function fileAttachment(message, fileKey, fileName, source) {
  if (!fileKey) return null;
  return {
    kind: 'file',
    resourceType: 'file',
    fileKey: String(fileKey),
    fileName: fileName ? String(fileName) : '',
    messageId: message.message_id || '',
    source,
  };
}
