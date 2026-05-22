import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const LEVELS = ['error', 'warn', 'info', 'debug'];
const LEVEL_RANK = Object.fromEntries(LEVELS.map((lvl, i) => [lvl, i]));

function formatText(level, args) {
  const body = args.map((arg) => {
    if (arg instanceof Error) return arg.stack || arg.message;
    if (typeof arg === 'string') return arg;
    try { return JSON.stringify(arg); } catch { return String(arg); }
  }).join(' ');
  return `[${new Date().toISOString()}] ${level.toUpperCase()} ${body}\n`;
}

function formatJson(level, args) {
  const event = { ts: new Date().toISOString(), level };
  const messages = [];
  for (const arg of args) {
    if (arg instanceof Error) {
      event.err = { message: arg.message, stack: arg.stack, code: arg.code };
    } else if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
      Object.assign(event, arg);
    } else {
      messages.push(typeof arg === 'string' ? arg : safeStringify(arg));
    }
  }
  if (messages.length) event.msg = messages.join(' ');
  return `${safeStringify(event)}\n`;
}

function safeStringify(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

export function createLogger(path, options = {}) {
  const format = options.format || process.env.A2A_LOG_FORMAT || 'text';
  const minLevel = options.level || process.env.A2A_LOG_LEVEL || (process.env.DEBUG ? 'debug' : 'info');
  const formatter = format === 'json' ? formatJson : formatText;

  function write(level, args) {
    if (LEVEL_RANK[level] > LEVEL_RANK[minLevel]) return;
    const line = formatter(level, args);
    process.stdout.write(line);
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, line);
    } catch {
      // Logging must never break message handling.
    }
  }

  return {
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
    debug: (...args) => write('debug', args),
  };
}
