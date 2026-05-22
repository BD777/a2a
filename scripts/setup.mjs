#!/usr/bin/env node
// Interactive setup wizard for A2A.
// Walks the user through Feishu app creation, validates credentials against the
// tenant_access_token endpoint, then writes config/agents.json, config/chats.json,
// and config/profiles/claude-relay.env. Zero external deps.

import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { request } from 'node:https';
import { execSync } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_DIR = join(REPO_ROOT, 'config');
const PROFILE_PATH = join(CONFIG_DIR, 'profiles', 'claude-relay.env');
const AGENTS_PATH = join(CONFIG_DIR, 'agents.json');
const CHATS_PATH = join(CONFIG_DIR, 'chats.json');
const DEFAULTS_PATH = join(CONFIG_DIR, 'setup-defaults.json');
const DEPENDENCY_LEDGER_PATH = join(CONFIG_DIR, 'dependencies.json');

const FALLBACK_DEFAULTS = {
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    primaryModel: '',
    opusModel: '',
    sonnetModel: '',
    haikuModel: '',
    compactWindow: '300000',
  },
  agents: {
    claude: { displayName: 'claude', workingDirRel: 'workspaces/claude' },
    codex: { displayName: 'codex', workingDirRel: 'workspaces/codex' },
  },
};

function loadDependencyLedger() {
  try {
    return JSON.parse(readFileSync(DEPENDENCY_LEDGER_PATH, 'utf8'));
  } catch {
    return {};
  }
}

const dependencyLedger = loadDependencyLedger();
const FEISHU_DOMAIN = feishuDomainUrl(process.env.A2A_FEISHU_DOMAIN || process.env.A2A_LARK_DOMAIN);
const FEISHU_OPEN_HOST = new URL(FEISHU_DOMAIN).hostname;

function cliDependency(name) {
  return (dependencyLedger.cli || []).find((item) => item?.name === name) || {};
}

function feishuDomainUrl(value) {
  const raw = String(value || 'feishu').trim();
  const lower = raw.toLowerCase();
  if (!raw || lower === 'feishu') return 'https://open.feishu.cn';
  if (lower === 'lark') return 'https://open.larksuite.com';
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, '');
  return `https://${raw.replace(/\/+$/, '')}`;
}

async function loadDefaults() {
  try {
    const raw = await readFile(DEFAULTS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      anthropic: { ...FALLBACK_DEFAULTS.anthropic, ...(parsed.anthropic || {}) },
      agents: {
        claude: { ...FALLBACK_DEFAULTS.agents.claude, ...(parsed.agents?.claude || {}) },
        codex: { ...FALLBACK_DEFAULTS.agents.codex, ...(parsed.agents?.codex || {}) },
      },
    };
  } catch {
    return FALLBACK_DEFAULTS;
  }
}

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};

function banner(title) {
  console.log(`\n${C.bold}${C.cyan}━━ ${title} ━━${C.reset}`);
}

function note(text) { console.log(`${C.dim}${text}${C.reset}`); }
function ok(text) { console.log(`${C.green}✓${C.reset} ${text}`); }
function warn(text) { console.log(`${C.yellow}⚠${C.reset} ${text}`); }
function fail(text) { console.log(`${C.red}✗${C.reset} ${text}`); }

const rl = createInterface({ input: stdin, output: stdout });
async function ask(prompt, fallback = '') {
  const suffix = fallback ? ` ${C.dim}[${fallback}]${C.reset}` : '';
  const answer = (await rl.question(`${prompt}${suffix} `)).trim();
  return answer || fallback;
}
async function confirm(prompt, fallback = false) {
  const yn = fallback ? 'Y/n' : 'y/N';
  const answer = (await rl.question(`${prompt} [${yn}] `)).trim().toLowerCase();
  if (!answer) return fallback;
  return ['y', 'yes'].includes(answer);
}

function which(cmd) {
  try {
    return execSync(`command -v ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch { return ''; }
}

function firstExecutable(paths) {
  return paths.find((path) => path && existsSync(path)) || '';
}

function detectCli(cmd) {
  return firstExecutable([
    join(REPO_ROOT, 'node_modules', '.bin', cmd),
    join(process.env.HOME || '', '.local', 'bin', cmd),
    join(process.env.HOME || '', '.bun', 'bin', cmd),
    join(process.env.HOME || '', '.npm-global', 'bin', cmd),
    join(process.env.HOME || '', '.volta', 'bin', cmd),
    `/opt/homebrew/bin/${cmd}`,
    `/usr/local/bin/${cmd}`,
    `/usr/bin/${cmd}`,
  ]) || which(cmd);
}

async function preflight() {
  banner('1. Preflight');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) {
    fail(`Node ${process.versions.node} is too old. Please use Node 20 or newer.`);
    process.exit(1);
  }
  ok(`Node ${process.versions.node}`);

  const claudePath = detectCli('claude');
  if (claudePath) ok(`claude CLI at ${claudePath} (will be reused)`);
  else warn(`claude CLI not found. Install: ${cliDependency('claude').install || 'npm install -g @anthropic-ai/claude-code'} (or see docs/DEPENDENCIES.md)`);

  const codexPath = detectCli('codex');
  if (codexPath) ok(`codex CLI at ${codexPath} (will be reused)`);
  else warn(`codex CLI not found. ${cliDependency('codex').install || 'Run npm ci so node_modules/.bin/codex is installed'} (or set A2A_CODEX_PATH).`);

  const jq = which('jq');
  if (!jq) note('jq not found — only used by scripts/a2a-admin.sh for pretty output. Optional.');

  return { claudePath, codexPath };
}

function feishuPostJson(path, body) {
  return new Promise((resolveHttp) => {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = request({
      method: 'POST',
      hostname: FEISHU_OPEN_HOST,
      path,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-length': data.length,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolveHttp({ ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (err) {
          resolveHttp({ ok: false, error: err.message });
        }
      });
    });
    req.on('error', (err) => resolveHttp({ ok: false, error: err.message }));
    req.write(data);
    req.end();
  });
}

async function validateBot(appId, appSecret) {
  const res = await feishuPostJson('/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: appId,
    app_secret: appSecret,
  });
  if (!res.ok) return { ok: false, reason: res.error };
  const code = res.body?.code;
  if (code === 0 && res.body?.tenant_access_token) return { ok: true };
  return { ok: false, reason: `code=${code} msg=${res.body?.msg || 'unknown'}` };
}

async function provisioningGuide() {
  banner('2. Feishu app provisioning');
  console.log(`
You need ${C.bold}two${C.reset} Feishu apps — one for the claude-code agent, one for codex.
Create them in the Feishu open platform console:

  ${C.cyan}${FEISHU_DOMAIN}/app${C.reset}

For ${C.bold}each${C.reset} app:

  1. Create a "Custom App" (自建应用) and add a bot (机器人).
  2. Enable ${C.bold}Long Connection (长连接)${C.reset} in "Event Subscriptions" (事件订阅) — A2A
     uses WebSocket only, no public callback URL is needed.
  3. Subscribe the event ${C.bold}im.message.receive_v1${C.reset} ("接收消息 v2.0").
  4. Grant the following scopes (开通权限) and ${C.bold}publish a new version${C.reset} so they go live:

       ${C.bold}im:message${C.reset}                    — read incoming messages and download image resources
       ${C.bold}im:message.group_msg${C.reset} / ${C.bold}im:message:send_as_bot${C.reset}
                                     — send threaded bot replies
       ${C.bold}contact:user.base:readonly${C.reset}    — resolve sender display names (optional;
                                       skip to keep logs anonymous)
       ${C.bold}cardkit:card:write${C.reset}            — only if A2A_FEISHU_STREAMING=true
       ${C.bold}im:message:recall${C.reset}             — optional cleanup for probe/empty messages

  5. Add the bot to the chats you want A2A to listen on.
  6. Note the ${C.bold}App ID${C.reset} (cli_xxx...) and ${C.bold}App Secret${C.reset} from "Credentials & Basic Info".

For full details see ${C.cyan}docs/SETUP.md${C.reset}.
`);
  await rl.question(`${C.dim}Press [Enter] when both apps are ready...${C.reset} `);
}

async function promptBot(label, cliId, defaultName, defaultWorkdir, runtimeKind, cardColor) {
  banner(`3. ${label} agent credentials`);
  let appId; let appSecret;
  while (true) {
    appId = await ask(`  App ID for ${cliId} (cli_...):`);
    if (!appId) { warn('App ID is required.'); continue; }
    appSecret = await ask(`  App Secret for ${cliId}:`);
    if (!appSecret) { warn('App Secret is required.'); continue; }
    note('  Verifying credentials with tenant_access_token...');
    const result = await validateBot(appId, appSecret);
    if (result.ok) { ok(`${cliId} credentials verified`); break; }
    fail(`Feishu rejected the credentials: ${result.reason}`);
    if (!(await confirm('  Re-enter?', true))) {
      warn('  Saving unverified credentials.');
      break;
    }
  }
  const name = await ask('  Display name (used in logs):', defaultName);
  const workingDir = await ask('  Working directory for this agent:', defaultWorkdir);
  return {
    larkAppId: appId,
    larkAppSecret: appSecret,
    name,
    cliId,
    runtime: runtimeKind,
    cardColor,
    workingDir,
  };
}

async function promptChats() {
  banner('4. Owned chat IDs');
  console.log(`
A2A only listens to chats whose IDs (oc_xxx...) you list here. Find one by
right-clicking a chat in Feishu desktop → "Copy chat ID" (复制群 ID), or via
${C.cyan}feishu-cli msg search-chats${C.reset} if you have it installed.

Enter chat IDs one per line. Empty line to finish, or "skip" to fill later.
`);
  const chats = [];
  while (true) {
    const id = await ask(`  chatId #${chats.length + 1}:`);
    if (!id) break;
    if (id.toLowerCase() === 'skip') return [];
    if (!id.startsWith('oc_')) {
      warn(`  "${id}" doesn't look like a Feishu chat ID (expected oc_...).`);
      if (!(await confirm('  Add anyway?', false))) continue;
    }
    const name = await ask('  Friendly name for this chat:', `chat ${chats.length + 1}`);
    chats.push({ name, chatId: id, enabled: true });
  }
  return chats;
}

async function promptRelayProfile(defaults) {
  banner('5. Anthropic relay env');
  console.log(`
The Claude Agent SDK reads its credentials from a profile env file. If you proxy
through an Anthropic-compatible relay, point ANTHROPIC_BASE_URL there. Otherwise
point at https://api.anthropic.com directly.
`);
  const baseUrl = await ask('  ANTHROPIC_BASE_URL:', defaults.baseUrl);
  let authToken = '';
  while (!authToken) {
    authToken = await ask('  ANTHROPIC_AUTH_TOKEN:');
    if (!authToken) warn('  ANTHROPIC_AUTH_TOKEN is required for Claude turns.');
  }
  const primaryModel = await ask('  ANTHROPIC_MODEL (optional; blank uses Claude CLI default):', defaults.primaryModel);
  const opusModel = await ask('  ANTHROPIC_DEFAULT_OPUS_MODEL (optional):', defaults.opusModel || primaryModel);
  const sonnetModel = await ask('  ANTHROPIC_DEFAULT_SONNET_MODEL (optional):', defaults.sonnetModel);
  const haikuModel = await ask('  ANTHROPIC_DEFAULT_HAIKU_MODEL (optional):', defaults.haikuModel);
  const compactWindow = await ask('  CLAUDE_CODE_AUTO_COMPACT_WINDOW:', defaults.compactWindow);
  return compactObject({
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: authToken,
    ANTHROPIC_MODEL: primaryModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL: opusModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: sonnetModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: haikuModel,
    CLAUDE_CODE_SUBAGENT_MODEL: primaryModel,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: compactWindow,
  });
}

async function maybeOverwrite(path) {
  if (!existsSync(path)) return true;
  warn(`  ${path} already exists.`);
  return confirm('  Overwrite?', false);
}

async function writePrivateFile(path, content) {
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && String(item) !== ''));
}

async function writeConfigs({ agents, chats, profile }) {
  banner('6. Writing config files');
  await mkdir(dirname(PROFILE_PATH), { recursive: true });
  if (await maybeOverwrite(AGENTS_PATH)) {
    await writePrivateFile(AGENTS_PATH, JSON.stringify(agents, null, 2) + '\n');
    ok(`wrote ${AGENTS_PATH}`);
  }
  if (chats.length > 0 && await maybeOverwrite(CHATS_PATH)) {
    await writePrivateFile(CHATS_PATH, JSON.stringify(chats, null, 2) + '\n');
    ok(`wrote ${CHATS_PATH}`);
  } else if (chats.length === 0) {
    warn(`skipped ${CHATS_PATH} — fill it in before starting the service`);
  }
  if (await maybeOverwrite(PROFILE_PATH)) {
    const lines = Object.entries(profile).map(([k, v]) => `${k}="${v}"`);
    await writePrivateFile(PROFILE_PATH, lines.join('\n') + '\n');
    ok(`wrote ${PROFILE_PATH}`);
  }
}

function printNextSteps({ chatsConfigured }) {
  banner('7. Next steps');
  console.log(`
${C.bold}Run locally:${C.reset}
  npm run doctor
  node src/index.js

${C.bold}Install as a user systemd service:${C.reset}
  scripts/install-systemd.sh
  journalctl --user -u a2a.service -f

${C.bold}Talk to it:${C.reset} send any plain message in an owned chat. Slash commands:
  /a2a status        — show running session state
  /a2a stop          — stop the session in this thread
`);
  if (!chatsConfigured) {
    warn('You skipped chat IDs. Edit config/chats.json before starting the service.');
  }
}

async function main() {
  console.log(`${C.bold}A2A setup wizard${C.reset}`);
  note(`repo root: ${REPO_ROOT}`);

  const defaults = await loadDefaults();
  await preflight();
  await provisioningGuide();
  const claudeBot = await promptBot(
    'Claude',
    'claude-code',
    defaults.agents.claude.displayName,
    resolve(REPO_ROOT, defaults.agents.claude.workingDirRel),
    'claude',
    'blue',
  );
  const codexBot = await promptBot(
    'Codex',
    'codex',
    defaults.agents.codex.displayName,
    resolve(REPO_ROOT, defaults.agents.codex.workingDirRel),
    'codex',
    'turquoise',
  );
  const chats = await promptChats();
  const profile = await promptRelayProfile(defaults.anthropic);
  await writeConfigs({ agents: [claudeBot, codexBot], chats, profile });
  printNextSteps({ chatsConfigured: chats.length > 0 });
  rl.close();
}

main().catch((err) => {
  fail(`Setup failed: ${err?.message || err}`);
  rl.close();
  process.exit(1);
});
