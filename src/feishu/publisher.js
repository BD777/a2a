import { splitForFeishu, splitForFeishuMarkdown } from './text-chunk.js';
import { buildAgentCard, buildStreamingAgentCard, buildSystemCard } from './cards.js';
import { StreamingCardController } from './streaming-card-controller.js';

const DEFAULT_AGENT_PALETTE = {
  'claude-code': 'blue',
  codex: 'turquoise',
};

export class FeishuPublisher {
  constructor({
    clients,
    agents,
    logger,
    chunkLimit,
    cardEnabled = true,
    cardByteLimit,
    agentColors,
    systemColors,
    streamingEnabled = false,
    streamTextMs = 800,
    streamThinkMs = 1500,
    streamTextMinChars = 30,
  }) {
    this.clients = clients;
    this.agents = agents;
    this.logger = logger;
    this.chunkLimit = chunkLimit;
    this.cardEnabled = cardEnabled;
    this.cardByteLimit = cardByteLimit;
    this.agentColors = { ...DEFAULT_AGENT_PALETTE, ...(agentColors || {}) };
    this.systemColors = systemColors || {};
    this.streamingEnabled = streamingEnabled;
    this.streamTextMs = streamTextMs;
    this.streamThinkMs = streamThinkMs;
    this.streamTextMinChars = streamTextMinChars;
    this.streamingDisabledSessions = new Set();
  }

  agentTemplate(cliId) {
    const bot = this.agents.get(cliId);
    return bot?.cardColor || this.agentColors[cliId] || '';
  }

  async publishSystem(session, text, { level = 'info', cliId = '' } = {}) {
    const app = (cliId && this.agents.get(cliId)) || this.firstAgent();
    try {
      if (this.cardEnabled) {
        return await this.sendCards(app.larkAppId, session.rootMessageId, text, (chunk, partIndex, partCount) => (
          buildSystemCard({ text: chunk, level, partIndex, partCount, templates: this.systemColors })
        ));
      }
      return await this.sendText(app.larkAppId, session.rootMessageId, text);
    } catch (err) {
      this.logger.warn('Feishu system publish failed:', err?.message || err);
      return null;
    }
  }

  async publishAgent(session, cliId, { content, round }) {
    const trimmed = String(content || '').trim();
    if (!trimmed) return null;
    const app = this.agents.get(cliId);
    if (!app) throw new Error(`missing publisher bot for cliId=${cliId}`);
    if (this.cardEnabled) {
      const template = this.agentTemplate(cliId);
      return this.sendCards(app.larkAppId, session.rootMessageId, trimmed, (chunk, partIndex, partCount) => (
        buildAgentCard({ cliId, round, content: chunk, partIndex, partCount, template })
      ));
    }
    return this.sendText(app.larkAppId, session.rootMessageId, trimmed);
  }

  async beginAgentTurn(session, cliId, round) {
    if (!this.streamingEnabled || !this.cardEnabled) return null;
    if (this.streamingDisabledSessions.has(session.id)) return null;
    const app = this.agents.get(cliId);
    if (!app) return null;

    const cardMinter = async () => {
      const skeleton = buildStreamingAgentCard({ cliId, round });
      let cardId;
      try {
        cardId = await this.clients.createCard(app.larkAppId, skeleton);
      } catch (err) {
        this.streamingDisabledSessions.add(session.id);
        this.logger?.warn?.(`streaming card disabled for session=${session.id}: ${err?.message || err}`);
        throw err;
      }
      let messageId;
      try {
        messageId = await this.clients.replyMessage(
          app.larkAppId,
          session.rootMessageId,
          { type: 'card', data: { card_id: cardId } },
          'interactive',
          true,
        );
      } catch (err) {
        this.streamingDisabledSessions.add(session.id);
        this.logger?.warn?.(`streaming card reply failed (session=${session.id}): ${err?.message || err}`);
        throw err;
      }
      return { appId: app.larkAppId, cardId, messageId };
    };

    const controller = new StreamingCardController({
      cardMinter,
      cliId,
      round,
      template: this.agentTemplate(cliId),
      clients: this.clients,
      logger: this.logger,
      textMs: this.streamTextMs,
      thinkMs: this.streamThinkMs,
      textMinChars: this.streamTextMinChars,
      byteLimit: this.cardByteLimit,
      fallback: ({ content, round: r }) => this.publishAgent(session, cliId, { content, round: r }),
    });
    const minted = await controller.start();
    if (!minted) return null;
    this.logger?.info?.(`streaming card started session=${session.id} cli=${cliId} round=${round} msg=${minted.messageId}`);
    return controller;
  }

  async sendCards(appId, rootMessageId, text, buildCard) {
    const chunks = splitForFeishuMarkdown(text, this.cardByteLimit ? { byteLimit: this.cardByteLimit } : undefined);
    if (chunks.length === 0) return null;
    const messageIds = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const card = buildCard(chunks[i], i + 1, chunks.length);
      const id = await this.clients.replyMessage(appId, rootMessageId, card, 'interactive', true);
      messageIds.push(id);
    }
    return messageIds[messageIds.length - 1];
  }

  async sendText(appId, rootMessageId, text) {
    const chunks = splitForFeishu(text, { limit: this.chunkLimit });
    if (chunks.length === 0) return null;
    const messageIds = [];
    for (const chunk of chunks) {
      const id = await this.clients.replyMessage(appId, rootMessageId, chunk, 'text', true);
      messageIds.push(id);
    }
    return messageIds[messageIds.length - 1];
  }

  firstAgent() {
    const first = this.agents.values().next().value;
    if (!first) throw new Error('no agents configured');
    return first;
  }
}
