import { eventRoot, extractEventParts, senderId } from './message-parser.js';

export class FeishuIngress {
  constructor({ clients, attachmentDownloader, scheduler, config, logger }) {
    this.clients = clients;
    this.attachmentDownloader = attachmentDownloader;
    this.scheduler = scheduler;
    this.config = config;
    this.logger = logger;
  }

  async handleEvent(appId, data, source) {
    const message = data?.message;
    if (!message?.message_id || !message.chat_id) return { ok: true, skipped: 'missing-message' };
    if (!this.config.ownedChatIds.has(message.chat_id)) return { ok: true, skipped: 'chat-not-owned' };
    const parts = extractEventParts(message);
    const attachments = await this.resolveAttachments(appId, parts.attachments);
    const senderType = data.sender?.sender_type || 'unknown';
    const id = senderId(data.sender);
    const senderLabel = await this.clients.senderLabel(appId, senderType, id);
    const record = {
      appId,
      source,
      messageId: message.message_id,
      rootMessageId: eventRoot(message),
      chatId: message.chat_id,
      chatType: message.chat_type === 'p2p' ? 'p2p' : 'group',
      msgType: message.message_type || 'text',
      text: parts.text,
      attachments,
      senderType,
      senderId: id,
      senderLabel,
      timeMs: Number(message.create_time || 0) || Date.now(),
    };
    const imageCount = record.attachments.filter((item) => item?.kind === 'image' && item.localPath).length;
    this.logger.info(`ingress ${source} chat=${record.chatId} root=${record.rootMessageId} msg=${record.messageId} chars=${record.text.length} images=${imageCount}`);
    this.scheduler.handleUserMessage(record).catch((err) => {
      this.logger.error(`scheduler failed for msg=${record.messageId}:`, err);
    });
    return { ok: true, queued: true };
  }

  async resolveAttachments(appId, attachments) {
    if (!this.attachmentDownloader) return attachments || [];
    return this.attachmentDownloader.resolve(appId, attachments);
  }
}
