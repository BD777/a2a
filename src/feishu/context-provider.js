import { formatTopicMessages, parseApiMessage } from './message-parser.js';

export class FeishuTopicContextProvider {
  constructor({ clients, config, logger }) {
    this.clients = clients;
    this.config = config;
    this.logger = logger;
  }

  async readTopic(appId, chatId, rootMessageId) {
    try {
      const raw = await this.clients.listThreadMessages(appId, chatId, rootMessageId, this.config.topicContextLimit);
      const parsed = raw.map((message) => parseApiMessage(message));
      const labels = new Map();
      for (const message of parsed) {
        const sender = message.sender || {};
        const senderType = sender.sender_type || sender.type || 'unknown';
        const senderId = sender.id || sender.sender_id?.open_id || '';
        const key = `${senderType}:${senderId}`;
        if (!labels.has(key)) labels.set(key, await this.clients.senderLabel(appId, senderType, senderId));
      }
      return formatTopicMessages(parsed, {
        timeZone: this.config.timeZone,
        messageCharLimit: this.config.messageCharLimit,
        senderLabel: (message) => {
          const sender = message.sender || {};
          const senderType = sender.sender_type || sender.type || 'unknown';
          const senderId = sender.id || sender.sender_id?.open_id || '';
          return labels.get(`${senderType}:${senderId}`) || `${senderType}:${senderId || 'unknown'}`;
        },
      });
    } catch (err) {
      this.logger.warn('Feishu topic context read skipped:', err?.message || err);
      return '';
    }
  }
}
