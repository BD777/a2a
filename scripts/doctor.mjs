#!/usr/bin/env node
// Installation and deployment readiness checks for A2A.
// Offline checks are safe by default. Online checks only read/validate Feishu
// app configuration unless --reply-test is explicitly provided.

import { chmod, readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { request } from 'node:https';

class Reporter {
  constructor() {
    this.errors = 0;
    this.warnings = 0;
  }

  section(title) {
    console.log(`\n== ${title} ==`);
  }

  pass(message) {
    console.log(`[ok] ${message}`);
  }

  info(message) {
    console.log(`[info] ${message}`);
  }

  warn(message) {
    this.warnings += 1;
    console.warn(`[warn] ${message}`);
  }

  fail(message) {
    this.errors += 1;
    console.error(`[fail] ${message}`);
  }

  summary() {
    console.log(`\nDoctor complete: ${this.errors} error(s), ${this.warnings} warning(s).`);
    if (this.errors > 0) process.exit(1);
  }
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG_DIR = join(REPO_ROOT, 'config');
const DEFAULT_DEPLOY_ENV = join(REPO_ROOT, 'deploy', 'a2a.env');
const DEPENDENCY_LEDGER_PATH = join(REPO_ROOT, 'config', 'dependencies.json');
const dependencyLedger = readJsonFileSync(DEPENDENCY_LEDGER_PATH, {});
const TESTED_CLI_MIN = Object.fromEntries((dependencyLedger.cli || []).map((item) => [item.name, item.testedVersion]).filter(([, version]) => version));

const options = parseArgs(process.argv.slice(2));
const report = new Reporter();

const deployEnv = existsSync(DEFAULT_DEPLOY_ENV) ? parseEnvFile(DEFAULT_DEPLOY_ENV) : {};
const env = { ...deployEnv, ...process.env };
const feishuDomain = feishuDomainUrl(env.A2A_FEISHU_DOMAIN || env.A2A_LARK_DOMAIN);
const feishuOpenHost = new URL(feishuDomain).hostname;
const configDir = resolveMaybe(env.A2A_CONFIG_DIR || DEFAULT_CONFIG_DIR);
const agentsFile = resolveMaybe(env.A2A_AGENTS_FILE || join(configDir, 'agents.json'));
const chatsFile = resolveMaybe(env.A2A_CHATS_FILE || join(configDir, 'chats.json'));
const profileFile = resolveMaybe(env.A2A_CLAUDE_PROFILE || join(configDir, 'profiles', 'claude-relay.env'));

await main();

async function main() {
  report.section('Runtime');
  checkNode();
  checkNpmVersion();
  checkDependencyLedger();

  const cliPaths = checkCliTools();

  report.section('Configuration');
  const agents = await checkAgents(cliPaths);
  const chats = await checkChats();
  await checkClaudeProfile(agents);
  checkCodexAuthConfig(agents);
  await checkSecretFileModes([agentsFile, chatsFile, profileFile, DEFAULT_DEPLOY_ENV].filter((file) => existsSync(file)));

  if (options.online) {
    report.section('Feishu online checks');
    await checkFeishuOnline(agents, chats);
  } else {
    report.info('Online Feishu checks skipped. Run `npm run doctor -- --online` after setup to validate app credentials and read permissions.');
  }

  report.summary();
}

function parseArgs(argv) {
  const parsed = {
    online: false,
    fixPermissions: false,
    streaming: false,
    replyTestMessageId: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--online') parsed.online = true;
    else if (arg === '--fix-permissions') parsed.fixPermissions = true;
    else if (arg === '--streaming') parsed.streaming = true;
    else if (arg === '--reply-test') {
      parsed.replyTestMessageId = argv[i + 1] || '';
      i += 1;
    } else if (arg.startsWith('--reply-test=')) {
      parsed.replyTestMessageId = arg.slice('--reply-test='.length);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      report.fail(`unknown option: ${arg}`);
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`A2A doctor

Usage:
  npm run doctor
  npm run doctor -- --fix-permissions
  npm run doctor -- --online
  npm run doctor -- --online --streaming
  npm run doctor -- --online --reply-test <Feishu message_id>

Options:
  --online           Validate Feishu credentials and read access to configured chats.
  --streaming        Also validate CardKit create permission. Implied when A2A_FEISHU_STREAMING=true.
  --reply-test ID    Explicitly post a short threaded test reply to ID, then try to delete it.
  --fix-permissions  chmod 600 local secret/config files that are too broad.
`);
}

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  const declared = dependencyLedger.runtime?.node || '>=20';
  const min = minVersionFromRange(declared) || '20.0.0';
  if (compareSemver(process.versions.node, min) >= 0) report.pass(`Node ${process.versions.node} satisfies ${declared}`);
  else report.fail(`Node ${process.versions.node} is too old; dependency ledger requires ${declared}`);
}

function checkNpmVersion() {
  const declared = dependencyLedger.runtime?.npm || '>=9';
  const min = minVersionFromRange(declared) || '9.0.0';
  const version = commandOutput('npm', ['--version']);
  if (!version) {
    report.fail(`npm not found; dependency ledger requires ${declared}`);
    return;
  }
  if (compareSemver(version, min) >= 0) report.pass(`npm ${version} satisfies ${declared}`);
  else report.fail(`npm ${version} is too old; dependency ledger requires ${declared}`);
}

function checkDependencyLedger() {
  if (!existsSync(join(REPO_ROOT, 'package-lock.json'))) {
    report.fail('package-lock.json is missing; reproducible npm install is not possible');
  } else {
    report.pass('package-lock.json present');
  }
  if (!existsSync(DEPENDENCY_LEDGER_PATH)) {
    report.fail(`dependency ledger missing: ${DEPENDENCY_LEDGER_PATH}`);
  } else {
    report.pass(`dependency ledger present: ${relativeToRepo(DEPENDENCY_LEDGER_PATH)}`);
  }

  for (const dep of dependencyLedger.npm || []) {
    const pkgJson = packageJsonPath(dep.name);
    if (!existsSync(pkgJson)) {
      report.fail(`npm dependency missing: ${dep.name}@${dep.version}; run npm ci`);
      continue;
    }
    const installed = readJsonFileSync(pkgJson, {});
    if (installed.version === dep.version) {
      report.pass(`npm dependency installed: ${dep.name}@${installed.version}`);
    } else {
      report.fail(`npm dependency version mismatch: ${dep.name} installed ${installed.version || 'unknown'}, ledger expects ${dep.version}`);
    }
    if (dep.binary) {
      const binary = join(REPO_ROOT, dep.binary);
      if (isExecutable(binary)) report.pass(`binary available: ${dep.binary}`);
      else report.fail(`binary missing or not executable: ${dep.binary}`);
    }
  }

  for (const service of dependencyLedger.externalServices || []) {
    if (service.required) report.info(`external service required: ${service.name}`);
  }
}

function checkCliTools() {
  const claudePath = findExecutable('claude', env.A2A_CLAUDE_PATH, [
    join(homedir(), '.local', 'bin', 'claude'),
    join(homedir(), '.bun', 'bin', 'claude'),
    join(homedir(), '.npm-global', 'bin', 'claude'),
    join(homedir(), '.volta', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ]);
  const codexPath = findExecutable('codex', env.A2A_CODEX_PATH, [
    join(REPO_ROOT, 'node_modules', '.bin', 'codex'),
    join(homedir(), '.local', 'bin', 'codex'),
    join(homedir(), '.bun', 'bin', 'codex'),
    join(homedir(), '.npm-global', 'bin', 'codex'),
    join(homedir(), '.volta', 'bin', 'codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    '/usr/bin/codex',
  ]);

  checkExecutable('claude', claudePath, 'A2A_CLAUDE_PATH');
  checkExecutable('codex', codexPath, 'A2A_CODEX_PATH');
  checkOptionalExecutable('curl');
  checkOptionalExecutable('jq');
  return { claude: claudePath, codex: codexPath };
}

function checkExecutable(name, path, envName) {
  if (!path) {
    report.fail(`${name} CLI not found; install it or set ${envName}=/absolute/path`);
    return;
  }
  const version = versionFor(path);
  report.pass(`${name} CLI found at ${path}${version ? ` (${version})` : ''}`);
  warnIfOlderThanTested(name, version);
}

function checkOptionalExecutable(name) {
  const path = commandPath(name);
  if (path) report.pass(`optional tool found: ${name} at ${path}`);
  else report.warn(`optional tool missing: ${name} (only needed for convenience/admin commands)`);
}

async function checkAgents(cliPaths) {
  const agents = await readJsonFile(agentsFile, 'agents config');
  if (!Array.isArray(agents) || agents.length === 0) {
    report.fail(`no agents found in ${agentsFile}; run npm run setup`);
    return [];
  }

  const seenCliIds = new Set();
  for (const agent of agents) {
    const label = agent?.cliId || '(missing cliId)';
    if (!agent || typeof agent !== 'object') {
      report.fail('agent entry must be an object');
      continue;
    }
    if (!agent.cliId) report.fail('agent entry missing cliId');
    if (seenCliIds.has(agent.cliId)) report.fail(`duplicate agent cliId: ${agent.cliId}`);
    seenCliIds.add(agent.cliId);
    if (!/^cli_[A-Za-z0-9_-]+$/.test(agent.larkAppId || '')) report.fail(`${label}: larkAppId must look like cli_...`);
    else report.pass(`${label}: larkAppId format ok`);
    if (!agent.larkAppSecret || /^REPLACE|CHANGE|xxx/i.test(agent.larkAppSecret)) report.fail(`${label}: larkAppSecret is missing or still a placeholder`);
    const runtime = agent.runtime || inferRuntimeKind(agent.cliId);
    if (!agent.runtime && runtime) report.warn(`${label}: runtime is inferred as "${runtime}"; add it to agents.json for portable config`);
    if (!['claude', 'codex'].includes(runtime)) report.fail(`${label}: runtime must be "claude" or "codex"`);
    if (runtime === 'claude' && !cliPaths.claude) report.fail(`${label}: claude runtime configured but claude CLI is unavailable`);
    if (runtime === 'codex' && !cliPaths.codex) report.fail(`${label}: codex runtime configured but codex CLI is unavailable`);
    const workingDir = agent.workingDir ? resolveMaybe(agent.workingDir) : REPO_ROOT;
    if (existsSync(workingDir)) report.pass(`${label}: workingDir exists`);
    else report.fail(`${label}: workingDir does not exist: ${workingDir}`);
  }
  return agents;
}

async function checkChats() {
  if (env.A2A_CHAT_IDS) {
    const chats = env.A2A_CHAT_IDS.split(',').map((chatId, index) => ({ name: `env chat ${index + 1}`, chatId: chatId.trim(), enabled: true })).filter((item) => item.chatId);
    checkChatList(chats, 'A2A_CHAT_IDS');
    return chats;
  }
  const chats = await readJsonFile(chatsFile, 'chats config');
  if (!Array.isArray(chats) || chats.filter((item) => item?.enabled !== false).length === 0) {
    report.fail(`no enabled chats found in ${chatsFile}; run npm run setup or set A2A_CHAT_IDS`);
    return [];
  }
  checkChatList(chats, chatsFile);
  return chats.filter((item) => item?.enabled !== false);
}

function checkChatList(chats, source) {
  for (const chat of chats) {
    if (chat?.enabled === false) continue;
    if (!/^oc_[A-Za-z0-9_-]+$/.test(chat?.chatId || '')) report.warn(`${source}: chatId does not look like oc_... (${chat?.name || 'unnamed'})`);
    else report.pass(`${source}: chat configured (${chat?.name || chat.chatId})`);
  }
}

async function checkClaudeProfile(agents) {
  const usesClaude = agents.some((agent) => (agent?.runtime || inferRuntimeKind(agent?.cliId)) === 'claude');
  if (!usesClaude) return;
  if (!existsSync(profileFile)) {
    report.fail(`Claude profile env missing: ${profileFile}`);
    return;
  }
  const profile = parseEnvFile(profileFile);
  for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']) {
    if (!profile[key] || /^REPLACE|CHANGE|xxx|your_/i.test(profile[key])) report.fail(`Claude profile missing usable ${key}`);
    else report.pass(`Claude profile has ${key}`);
  }
}

function checkCodexAuthConfig(agents) {
  const usesCodex = agents.some((agent) => (agent?.runtime || inferRuntimeKind(agent?.cliId)) === 'codex');
  if (!usesCodex) return;
  const codexHome = resolveMaybe(env.CODEX_HOME || join(homedir(), '.codex'));
  const configPath = join(codexHome, 'config.toml');
  const authPath = join(codexHome, 'auth.json');
  const hasApiKeyEnv = Boolean(env.OPENAI_API_KEY || env.CODEX_API_KEY);

  if (existsSync(configPath)) {
    report.pass(`Codex config present: ${configPath}`);
  } else {
    report.warn(`Codex config not found at ${configPath}; run codex interactively or set CODEX_HOME/A2A_CODEX_* before relying on Codex turns`);
  }

  if (existsSync(authPath)) {
    report.pass(`Codex auth state present: ${authPath}`);
  } else if (hasApiKeyEnv) {
    report.pass('Codex provider API key env detected');
  } else {
    report.warn(`Codex auth state not found at ${authPath}; provider credentials may still live in config.toml, but verify \`codex\` works interactively on this host`);
  }
}

async function checkSecretFileModes(files) {
  for (const file of files) {
    let st;
    try {
      st = await stat(file);
    } catch {
      continue;
    }
    const mode = st.mode & 0o777;
    if ((mode & 0o077) === 0) {
      report.pass(`${file} mode ${mode.toString(8)} is private`);
      continue;
    }
    if (options.fixPermissions) {
      await chmod(file, 0o600);
      report.pass(`${file} chmod 600`);
    } else {
      report.warn(`${file} mode ${mode.toString(8)} is broader than 600; run npm run doctor -- --fix-permissions`);
    }
  }
}

async function checkFeishuOnline(agents, chats) {
  if (agents.length === 0 || chats.length === 0) {
    report.fail('online checks need valid agents and chats');
    return;
  }
  const { Client, LoggerLevel } = await import('@larksuiteoapi/node-sdk');
  const shouldCheckStreaming = options.streaming || String(env.A2A_FEISHU_STREAMING || '').toLowerCase() === 'true';
  for (const agent of agents) {
    const token = await validateTenantToken(agent);
    if (!token) continue;
    const client = new Client({
      appId: agent.larkAppId,
      appSecret: agent.larkAppSecret,
      domain: feishuDomain,
      loggerLevel: LoggerLevel.error,
    });
    for (const chat of chats) {
      await checkChatRead(client, agent, chat);
    }
    if (shouldCheckStreaming) await checkCardKitCreate(client, agent);
    if (options.replyTestMessageId) await checkReplyAndDelete(client, agent, options.replyTestMessageId);
  }
}

async function validateTenantToken(agent) {
  const res = await postJson('/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: agent.larkAppId,
    app_secret: agent.larkAppSecret,
  });
  if (res.ok && res.body?.code === 0 && res.body?.tenant_access_token) {
    report.pass(`${agent.cliId}: Feishu App ID/Secret validated`);
    return res.body.tenant_access_token;
  }
  report.fail(`${agent.cliId}: Feishu credential validation failed (${formatFeishuError(res)})`);
  return '';
}

async function checkChatRead(client, agent, chat) {
  try {
    const res = await client.im.v1.message.list({
      params: {
        container_id_type: 'chat',
        container_id: chat.chatId,
        page_size: 1,
      },
    });
    if (res.code === 0) report.pass(`${agent.cliId}: can list messages for chat ${chat.name || chat.chatId}`);
    else report.fail(`${agent.cliId}: cannot list messages for chat ${chat.name || chat.chatId} (${res.msg || 'unknown'} code=${res.code})`);
  } catch (err) {
    report.fail(`${agent.cliId}: message list check failed for chat ${chat.name || chat.chatId}: ${err?.message || err}`);
  }
}

async function checkCardKitCreate(client, agent) {
  try {
    const card = {
      schema: '2.0',
      config: { wide_screen_mode: true, streaming_mode: true },
      body: { elements: [{ tag: 'markdown', element_id: 'a2a_doctor_body', content: 'A2A doctor CardKit permission probe.' }] },
    };
    const res = await client.cardkit.v1.card.create({
      data: { type: 'card_json', data: JSON.stringify(card) },
    });
    if (res.code === 0 && res.data?.card_id) report.pass(`${agent.cliId}: CardKit create permission ok`);
    else report.fail(`${agent.cliId}: CardKit create failed (${res.msg || 'unknown'} code=${res.code})`);
  } catch (err) {
    report.fail(`${agent.cliId}: CardKit create check failed: ${err?.message || err}`);
  }
}

async function checkReplyAndDelete(client, agent, messageId) {
  try {
    const res = await client.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text: `A2A doctor reply permission probe (${agent.cliId}).` }),
        reply_in_thread: true,
      },
    });
    if (res.code !== 0 || !res.data?.message_id) {
      report.fail(`${agent.cliId}: reply test failed (${res.msg || 'unknown'} code=${res.code})`);
      return;
    }
    const replyId = res.data.message_id;
    report.pass(`${agent.cliId}: reply permission ok`);
    try {
      const del = await client.im.v1.message.delete({ path: { message_id: replyId } });
      if (del.code === 0) report.pass(`${agent.cliId}: delete/retract permission ok`);
      else report.warn(`${agent.cliId}: reply worked, but delete/retract failed (${del.msg || 'unknown'} code=${del.code})`);
    } catch (err) {
      report.warn(`${agent.cliId}: reply worked, but delete/retract check failed: ${err?.message || err}`);
    }
  } catch (err) {
    report.fail(`${agent.cliId}: reply test failed: ${err?.message || err}`);
  }
}

function postJson(path, body) {
  return new Promise((resolveHttp) => {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = request({
      method: 'POST',
      hostname: feishuOpenHost,
      path,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-length': data.length,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolveHttp({ ok: true, status: res.statusCode, body: JSON.parse(raw) });
        } catch (err) {
          resolveHttp({ ok: false, status: res.statusCode, error: err.message });
        }
      });
    });
    req.on('error', (err) => resolveHttp({ ok: false, error: err.message }));
    req.write(data);
    req.end();
  });
}

function formatFeishuError(res) {
  if (!res.ok) return res.error || `http ${res.status || 'unknown'}`;
  return `code=${res.body?.code} msg=${res.body?.msg || 'unknown'}`;
}

async function readJsonFile(path, label) {
  try {
    const text = await readFile(path, 'utf8');
    return JSON.parse(text);
  } catch (err) {
    report.fail(`cannot read ${label} at ${path}: ${err?.message || err}`);
    return null;
  }
}

function parseEnvFile(path) {
  try {
    const envFile = {};
    const text = readFileSyncSafe(path);
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      envFile[match[1]] = expandEnv(unquote(match[2].trim()));
    }
    return envFile;
  } catch {
    return {};
  }
}

function readFileSyncSafe(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function readJsonFileSync(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function expandEnv(value) {
  return value
    .replaceAll('<repo-root>', REPO_ROOT)
    .replaceAll('$HOME', homedir())
    .replaceAll('${HOME}', homedir());
}

function feishuDomainUrl(value) {
  const raw = String(value || 'feishu').trim();
  const lower = raw.toLowerCase();
  if (!raw || lower === 'feishu') return 'https://open.feishu.cn';
  if (lower === 'lark') return 'https://open.larksuite.com';
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, '');
  return `https://${raw.replace(/\/+$/, '')}`;
}

function resolveMaybe(path) {
  const expanded = expandEnv(String(path || ''));
  return isAbsolute(expanded) ? expanded : resolve(REPO_ROOT, expanded);
}

function findExecutable(name, override, candidates) {
  if (override) {
    const resolved = resolveMaybe(override);
    if (isExecutable(resolved)) return resolved;
  }
  return candidates.map(resolveMaybe).find(isExecutable) || commandPath(name) || '';
}

function commandPath(name) {
  const result = spawnSync('sh', ['-lc', `command -v ${name}`], { encoding: 'utf8' });
  if (result.status === 0) return result.stdout.trim();
  return '';
}

function isExecutable(path) {
  if (!path || !existsSync(path)) return false;
  const result = spawnSync('test', ['-x', path]);
  return result.status === 0;
}

function versionFor(path) {
  const result = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0) return '';
  return (result.stdout || result.stderr || '').trim().split(/\r?\n/)[0];
}

function commandOutput(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0) return '';
  return (result.stdout || result.stderr || '').trim().split(/\r?\n/)[0];
}

function warnIfOlderThanTested(name, versionText) {
  const min = TESTED_CLI_MIN[name];
  const found = versionText?.match(/\d+\.\d+\.\d+/)?.[0];
  if (!min || !found) return;
  if (compareSemver(found, min) < 0) {
    report.warn(`${name} CLI ${found} is older than the tested Docker pin ${min}; reuse may work, but upgrade if runtime turns fail`);
  }
}

function compareSemver(left, right) {
  const a = String(left).match(/\d+(?:\.\d+){0,2}/)?.[0]?.split('.').map(Number) || [];
  const b = String(right).match(/\d+(?:\.\d+){0,2}/)?.[0]?.split('.').map(Number) || [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function minVersionFromRange(range) {
  return String(range || '').match(/\d+(?:\.\d+){0,2}/)?.[0] || '';
}

function packageJsonPath(pkgName) {
  return join(REPO_ROOT, 'node_modules', ...pkgName.split('/'), 'package.json');
}

function relativeToRepo(path) {
  return path.startsWith(`${REPO_ROOT}/`) ? path.slice(REPO_ROOT.length + 1) : path;
}

function inferRuntimeKind(cliId) {
  const lower = String(cliId || '').toLowerCase();
  if (lower.startsWith('claude')) return 'claude';
  if (lower.startsWith('codex')) return 'codex';
  return '';
}
