#!/usr/bin/env node
import { loadA2aConfig } from './config.js';
import { createLogger } from './logger.js';
import { createMessages } from './protocol/messages.js';
import { ThreadContextStore } from './store/thread-context-store.js';
import { FeishuClientPool } from './feishu/client.js';
import { FeishuAttachmentDownloader } from './feishu/attachment-downloader.js';
import { FeishuTopicContextProvider } from './feishu/context-provider.js';
import { FeishuPublisher } from './feishu/publisher.js';
import { FeishuIngress } from './feishu/ingress.js';
import { startFeishuReceiver } from './feishu/receiver.js';
import { AgentRuntimeManager } from './runtime/agent-runtime-manager.js';
import { A2AScheduler } from './scheduler/a2a-scheduler.js';
import { startHttpServer } from './http-server.js';

const config = loadA2aConfig();
const logger = createLogger(config.logPath);
const messages = createMessages({ messagesFile: config.messagesFile });
const store = new ThreadContextStore({
  stateDir: config.stateDir,
  seenMessageLimit: config.seenMessageLimit,
});
store.load();

const clients = new FeishuClientPool({
  bots: config.bots,
  logger,
  domain: config.feishuDomain,
  pageSizeCap: config.feishuPageSizeCap,
});
const attachmentDownloader = new FeishuAttachmentDownloader({ clients, config, logger });
const contextProvider = new FeishuTopicContextProvider({
  clients,
  attachmentDownloader,
  config,
  logger,
});
const runtime = new AgentRuntimeManager({ config, logger });
const publisher = new FeishuPublisher({
  clients,
  agents: config.agents,
  logger,
  chunkLimit: config.feishuChunkLimit,
  cardEnabled: config.feishuCardEnabled,
  cardByteLimit: config.feishuCardByteLimit,
  agentColors: config.feishuCardAgentColors,
  systemColors: config.feishuCardSystemColors,
  streamingEnabled: config.feishuStreaming,
  streamTextMs: config.feishuStreamTextMs,
  streamThinkMs: config.feishuStreamThinkMs,
  streamTextMinChars: config.feishuStreamTextMinChars,
});
const scheduler = new A2AScheduler({ store, contextProvider, runtime, publisher, config, logger, messages });
const ingress = new FeishuIngress({ clients, attachmentDownloader, scheduler, config, logger });

startHttpServer({ host: config.host, port: config.port, logger, scheduler });
startFeishuReceiver({
  app: config.receiver,
  ownedChatIds: config.ownedChatIds,
  onMessage: (appId, data, source) => ingress.handleEvent(appId, data, source),
  logger,
  config,
});

logger.info(`A2A ready. ownedChats=${[...config.ownedChatIds].join(',')} agents=${config.agentOrder.join(' -> ')} receiver=${config.receiverCliId}`);
scheduler.resumeRunningSessions();
