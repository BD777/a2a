import { Client, LoggerLevel } from '@larksuiteoapi/node-sdk';

export class FeishuClientPool {
  constructor({ bots, logger, domain, pageSizeCap = 50 }) {
    this.bots = new Map(bots.map((bot) => [bot.larkAppId, bot]));
    this.clients = new Map();
    this.senderCache = new Map();
    this.logger = logger;
    this.domain = domain;
    this.pageSizeCap = Math.max(1, Number(pageSizeCap) || 50);
  }

  bot(appId) {
    const bot = this.bots.get(appId);
    if (!bot) throw new Error(`unknown Feishu appId: ${appId}`);
    return bot;
  }

  client(appId) {
    if (!this.clients.has(appId)) {
      const bot = this.bot(appId);
      this.clients.set(appId, new Client({
        appId: bot.larkAppId,
        appSecret: bot.larkAppSecret,
        ...(this.domain ? { domain: this.domain } : {}),
        loggerLevel: LoggerLevel.error,
      }));
    }
    return this.clients.get(appId);
  }

  async replyMessage(appId, messageId, content, msgType = 'text', replyInThread = true) {
    const body = msgType === 'text'
      ? JSON.stringify({ text: content })
      : (typeof content === 'string' ? content : JSON.stringify(content));
    const res = await this.client(appId).im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: msgType,
        content: body,
        ...(replyInThread ? { reply_in_thread: true } : {}),
      },
    });
    if (res.code !== 0) throw new Error(`Feishu reply failed: ${res.msg} (code=${res.code})`);
    const replyId = res.data?.message_id;
    if (!replyId) throw new Error('Feishu reply did not return message_id');
    return replyId;
  }

  async deleteMessage(appId, messageId) {
    const res = await this.client(appId).im.v1.message.delete({
      path: { message_id: messageId },
    });
    if (res.code !== 0) {
      const err = new Error(`Feishu message.delete failed: ${res.msg} (code=${res.code})`);
      err.code = res.code;
      throw err;
    }
  }

  async createCard(appId, cardJson) {
    const res = await this.client(appId).cardkit.v1.card.create({
      data: { type: 'card_json', data: JSON.stringify(cardJson) },
    });
    if (res.code !== 0) {
      const err = new Error(`Feishu card.create failed: ${res.msg} (code=${res.code})`);
      err.code = res.code;
      throw err;
    }
    const cardId = res.data?.card_id;
    if (!cardId) throw new Error('Feishu card.create did not return card_id');
    return cardId;
  }

  async updateCardElementContent(appId, cardId, elementId, content, sequence) {
    const res = await this.client(appId).cardkit.v1.cardElement.content({
      path: { card_id: cardId, element_id: elementId },
      data: { content: content || '', sequence },
    });
    if (res.code !== 0) {
      const err = new Error(`Feishu cardElement.content failed: ${res.msg} (code=${res.code})`);
      err.code = res.code;
      throw err;
    }
  }

  async replaceCard(appId, cardId, cardJson, sequence) {
    const res = await this.client(appId).cardkit.v1.card.update({
      path: { card_id: cardId },
      data: {
        card: { type: 'card_json', data: JSON.stringify(cardJson) },
        sequence,
      },
    });
    if (res.code !== 0) {
      const err = new Error(`Feishu card.update failed: ${res.msg} (code=${res.code})`);
      err.code = res.code;
      throw err;
    }
  }

  async listThreadMessages(appId, chatId, rootMessageId, pageSize) {
    const c = this.client(appId);
    const threadId = await this.resolveThreadId(c, rootMessageId);
    if (threadId) return this.listByContainer(c, 'thread', threadId, pageSize, true);
    const messages = await this.listByContainer(c, 'chat', chatId, pageSize, false);
    return messages
      .filter((message) => message.message_id === rootMessageId || message.root_id === rootMessageId)
      .sort((a, b) => String(a.create_time || '').localeCompare(String(b.create_time || '')));
  }

  async getMessageResource(appId, { messageId, fileKey, type }) {
    return this.client(appId).im.v1.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type },
    });
  }

  async resolveThreadId(client, rootMessageId) {
    try {
      const res = await client.im.v1.message.get({ path: { message_id: rootMessageId } });
      if (res.code === 0) return res.data?.items?.[0]?.thread_id || '';
    } catch {
      // Chat scan below still works when message.get is unavailable.
    }
    return '';
  }

  async listByContainer(client, containerType, containerId, pageSize, asc) {
    const all = [];
    let pageToken = undefined;
    do {
      const res = await client.im.v1.message.list({
        params: {
          container_id_type: containerType,
          container_id: containerId,
          page_size: Math.min(pageSize, this.pageSizeCap),
          sort_type: asc ? 'ByCreateTimeAsc' : 'ByCreateTimeDesc',
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      if (res.code !== 0) throw new Error(`Feishu list messages failed: ${res.msg} (code=${res.code})`);
      if (Array.isArray(res.data?.items)) all.push(...res.data.items);
      pageToken = res.data?.page_token;
      if (all.length >= pageSize) break;
    } while (pageToken);
    const capped = all.slice(0, pageSize);
    return asc ? capped : capped.reverse();
  }

  async senderLabel(appId, senderType, id) {
    if (!id) return `${senderType || 'sender'}:unknown`;
    const key = `${appId}:${senderType}:${id}`;
    if (this.senderCache.has(key)) return this.senderCache.get(key);
    let label = `${senderType || 'sender'}:${id}`;
    if (senderType === 'user') {
      try {
        const res = await this.client(appId).contact.v3.user.get({
          path: { user_id: id },
          params: { user_id_type: 'open_id' },
        });
        const name = res.data?.user?.name || res.data?.user?.en_name;
        if (res.code === 0 && name) label = `${name} (user:${id})`;
      } catch (err) {
        this.logger.debug('sender label lookup skipped:', err?.message || err);
      }
    } else if (senderType === 'app' || senderType === 'bot') {
      const bot = [...this.bots.values()].find((item) => item.larkAppId === id);
      label = bot ? `${bot.name || bot.cliId} (${bot.cliId})` : `${senderType}:${id}`;
    }
    this.senderCache.set(key, label);
    return label;
  }
}
