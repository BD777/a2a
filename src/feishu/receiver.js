import { EventDispatcher, LoggerLevel, WSClient } from '@larksuiteoapi/node-sdk';
import { isBotSender } from './message-parser.js';

export function startFeishuReceiver({ app, ownedChatIds, onMessage, logger, config }) {
  const reconnectGiveup = config?.wsReconnectGiveup ?? 10;
  const reconnectGiveupMs = config?.wsReconnectGiveupMs ?? 5 * 60 * 1000;
  const wsLoggerLevel = config?.logLevel === 'debug' ? LoggerLevel.info : LoggerLevel.warn;

  const dispatcher = new EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      try {
        const message = data?.message;
        if (!message?.message_id || !message.chat_id) return;
        if (!ownedChatIds.has(message.chat_id)) return;
        if (isBotSender(data.sender)) return;
        await onMessage(app.larkAppId, data, 'feishu-ws');
      } catch (err) {
        logger.error('Feishu receiver handler failed:', err);
      }
    },
  });

  const state = {
    reconnectAttempts: 0,
    firstReconnectAt: 0,
  };

  const giveUp = (reason) => {
    logger.error(`Feishu WS giving up for ${app.cliId} (${app.larkAppId}): ${reason}. exiting so the supervisor can restart.`);
    setTimeout(() => process.exit(1), 200).unref();
  };

  const wsClient = new WSClient({
    appId: app.larkAppId,
    appSecret: app.larkAppSecret,
    ...(config?.feishuDomain ? { domain: config.feishuDomain } : {}),
    loggerLevel: wsLoggerLevel,
    onReady: () => {
      state.reconnectAttempts = 0;
      state.firstReconnectAt = 0;
      logger.info(`Feishu WS connected for ${app.cliId} (${app.larkAppId})`);
    },
    onReconnecting: () => {
      state.reconnectAttempts += 1;
      if (!state.firstReconnectAt) state.firstReconnectAt = Date.now();
      logger.warn(`Feishu WS reconnecting for ${app.cliId} (${app.larkAppId}) attempt=${state.reconnectAttempts}`);
      if (state.reconnectAttempts >= reconnectGiveup) {
        giveUp(`exceeded ${reconnectGiveup} reconnect attempts`);
        return;
      }
      const elapsed = Date.now() - state.firstReconnectAt;
      if (elapsed > reconnectGiveupMs) {
        giveUp(`reconnect window ${Math.round(elapsed / 1000)}s exceeded ${Math.round(reconnectGiveupMs / 1000)}s`);
      }
    },
    onReconnected: () => {
      state.reconnectAttempts = 0;
      state.firstReconnectAt = 0;
      logger.info(`Feishu WS reconnected for ${app.cliId} (${app.larkAppId})`);
    },
    onError: (err) => logger.error(`Feishu WS failed for ${app.cliId} (${app.larkAppId}):`, err),
  });
  wsClient.start({ eventDispatcher: dispatcher });
  logger.info(`Feishu receiver started for ${app.cliId} (${app.larkAppId})`);
  return wsClient;
}
