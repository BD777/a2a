import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function splitList(value, fallback = []) {
  const source = value || fallback.join(',');
  return source
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function chatIdsFromConfig(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object') return '';
        if (item.enabled === false) return '';
        return item.chatId || item.chat_id || item.id || '';
      })
      .map((item) => String(item).trim())
      .filter(Boolean);
  }
  if (value && typeof value === 'object') {
    return chatIdsFromConfig(value.chats || value.chatIds || value.chat_ids || []);
  }
  return [];
}

function boolEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseJsonEnv(name) {
  const raw = process.env[name];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function feishuDomainUrl(value) {
  const raw = String(value || 'feishu').trim();
  const lower = raw.toLowerCase();
  if (!raw || lower === 'feishu') return 'https://open.feishu.cn';
  if (lower === 'lark') return 'https://open.larksuite.com';
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, '');
  return `https://${raw.replace(/\/+$/, '')}`;
}

function requireBot(bots, cliId) {
  const bot = bots.find((item) => item.cliId === cliId);
  if (!bot) throw new Error(`missing bot config for cliId=${cliId}`);
  if (!bot.larkAppId || !bot.larkAppSecret) {
    throw new Error(`bot config ${cliId} must include larkAppId and larkAppSecret`);
  }
  return bot;
}

export function loadA2aConfig() {
  const appHome = process.env.A2A_HOME || join(homedir(), '.a2a');
  const projectDir = process.env.A2A_PROJECT_DIR || process.cwd();
  const configDir = process.env.A2A_CONFIG_DIR || join(projectDir, 'config');
  const agentsFile = process.env.A2A_AGENTS_FILE || join(configDir, 'agents.json');
  const chatsFile = process.env.A2A_CHATS_FILE || join(configDir, 'chats.json');
  if (!existsSync(agentsFile)) {
    throw new Error(`missing A2A agents config: ${agentsFile}`);
  }

  const bots = readJson(agentsFile, []);
  if (!Array.isArray(bots) || bots.length === 0) throw new Error(`no agents found in ${agentsFile}`);
  const configuredChatIds = process.env.A2A_CHAT_IDS
    ? splitList(process.env.A2A_CHAT_IDS)
    : chatIdsFromConfig(readJson(chatsFile, []));
  if (configuredChatIds.length === 0) {
    throw new Error(`missing owned chat config: set A2A_CHAT_IDS or create ${chatsFile}`);
  }

  const agentOrder = splitList(process.env.A2A_AGENT_ORDER, ['claude-code', 'codex']);
  const receiverCliId = process.env.A2A_RECEIVER_CLI_ID || agentOrder[0] || 'claude-code';
  const agents = new Map(agentOrder.map((cliId) => [cliId, requireBot(bots, cliId)]));
  const receiver = requireBot(bots, receiverCliId);

  const stateDir = process.env.A2A_STATE_DIR || join(appHome, 'state');
  const logPath = process.env.A2A_LOG_PATH || join(appHome, 'logs', 'a2a.log');
  const logLevel = process.env.A2A_LOG_LEVEL || (process.env.DEBUG ? 'debug' : 'info');
  const claudePath = process.env.A2A_CLAUDE_PATH
    || firstExecutable([
      join(homedir(), '.local', 'bin', 'claude'),
      join(homedir(), '.bun', 'bin', 'claude'),
      join(homedir(), '.npm-global', 'bin', 'claude'),
      join(homedir(), '.volta', 'bin', 'claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      '/usr/bin/claude',
    ]);
  const codexPath = process.env.A2A_CODEX_PATH
    || firstExecutable([
      join(projectDir, 'node_modules', '.bin', 'codex'),
      join(homedir(), '.local', 'bin', 'codex'),
      join(homedir(), '.bun', 'bin', 'codex'),
      join(homedir(), '.npm-global', 'bin', 'codex'),
      join(homedir(), '.volta', 'bin', 'codex'),
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      '/usr/bin/codex',
    ]);

  return {
    appHome,
    projectDir,
    configDir,
    agentsFile,
    chatsFile,
    bots,
    agents,
    agentOrder,
    receiver,
    receiverCliId,
    ownedChatIds: new Set(configuredChatIds),
    host: process.env.A2A_EVENT_HOST || '127.0.0.1',
    port: Number(process.env.A2A_EVENT_PORT || 39876),
    timeZone: process.env.A2A_TIME_ZONE || 'Asia/Shanghai',
    feishuDomain: feishuDomainUrl(process.env.A2A_FEISHU_DOMAIN || process.env.A2A_LARK_DOMAIN),
    stateDir,
    logPath,
    logLevel,
    topicContextLimit: numberEnv('A2A_THREAD_CONTEXT_LIMIT', 500),
    messageCharLimit: numberEnv('A2A_THREAD_MESSAGE_CHAR_LIMIT', 4000),
    feishuChunkLimit: numberEnv('A2A_FEISHU_CHUNK_LIMIT', 3500),
    feishuCardEnabled: boolEnv('A2A_FEISHU_CARD', true),
    feishuCardByteLimit: numberEnv('A2A_FEISHU_CARD_BYTE_LIMIT', 4500),
    feishuPageSizeCap: numberEnv('A2A_FEISHU_PAGE_SIZE_CAP', 50),
    feishuCardAgentColors: parseJsonEnv('A2A_CARD_AGENT_COLORS') || {},
    feishuCardSystemColors: parseJsonEnv('A2A_CARD_SYSTEM_COLORS') || {},
    feishuStreaming: boolEnv('A2A_FEISHU_STREAMING', false),
    feishuStreamTextMs: numberEnv('A2A_FEISHU_STREAM_TEXT_MS', 800),
    feishuStreamThinkMs: numberEnv('A2A_FEISHU_STREAM_THINK_MS', 1500),
    feishuStreamTextMinChars: numberEnv('A2A_FEISHU_STREAM_TEXT_MIN_CHARS', 30),
    messagesFile: process.env.A2A_MESSAGES_FILE || join(configDir, 'messages.json'),
    seenMessageLimit: numberEnv('A2A_SEEN_MESSAGE_LIMIT', 5000),
    wsReconnectGiveup: numberEnv('A2A_WS_RECONNECT_GIVEUP', 10),
    wsReconnectGiveupMs: numberEnv('A2A_WS_RECONNECT_GIVEUP_MS', 5 * 60 * 1000),
    maxTurnsSinceUser: numberEnv('A2A_MAX_TURNS_SINCE_USER', 100),
    turnTimeoutMs: numberEnv('A2A_TURN_TIMEOUT_MS', 2 * 60 * 60 * 1000),
    turnRetry: {
      attempts: numberEnv('A2A_TURN_RETRY_ATTEMPTS', 3),
      baseMs: numberEnv('A2A_TURN_RETRY_BASE_MS', 2000),
      capMs: numberEnv('A2A_TURN_RETRY_CAP_MS', 30000),
    },
    sessionTimeoutMs: numberEnv('A2A_SESSION_TIMEOUT_MS', 4 * 60 * 60 * 1000),
    publishSystemLifecycle: boolEnv('A2A_PUBLISH_SYSTEM_LIFECYCLE', false),
    codex: {
      model: process.env.A2A_CODEX_MODEL || '',
      codexPathOverride: codexPath,
      // sandboxMode defaults to danger-full-access to match Claude's
      // permissionMode='dontAsk' (both runtimes start permissive). Override via
      // A2A_CODEX_SANDBOX for stricter posture on shared / public deployments.
      sandboxMode: process.env.A2A_CODEX_SANDBOX || 'danger-full-access',
      approvalPolicy: process.env.A2A_CODEX_APPROVAL || 'never',
      reasoningEffort: process.env.A2A_CODEX_REASONING || 'xhigh',
      webSearchMode: process.env.A2A_CODEX_WEB_SEARCH || 'live',
      sseErrorLogPath: process.env.A2A_CODEX_SSE_ERROR_LOG
        || join(homedir(), '.codex', 'modelhub-proxy', 'sse-errors.log'),
    },
    claude: {
      model: process.env.A2A_CLAUDE_MODEL || '',
      pathToClaudeCodeExecutable: claudePath,
      profilePath: process.env.A2A_CLAUDE_PROFILE || join(configDir, 'profiles', 'claude-relay.env'),
      permissionMode: process.env.A2A_CLAUDE_PERMISSION_MODE || 'dontAsk',
      toolsMode: process.env.A2A_CLAUDE_TOOLS || 'default',
      effort: process.env.A2A_CLAUDE_EFFORT || 'max',
    },
  };
}

function firstExecutable(paths) {
  return paths.find((path) => path && existsSync(path)) || '';
}
