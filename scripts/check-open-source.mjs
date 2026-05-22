#!/usr/bin/env node
// High-signal checks that should pass before publishing or packaging this repo.
// This scans tracked plus untracked, non-ignored files by default so newly added
// release files are checked before they are staged. Ignored local credentials
// are scanned only with --all-local.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = new Set(process.argv.slice(2));
const scanIgnoredLocal = args.has('--all-local');

const gitRoot = maybeExecGit(['rev-parse', '--show-toplevel']).trim();
const root = gitRoot || resolve(process.cwd());
process.chdir(root);

const files = scanIgnoredLocal ? localFiles() : releaseSurfaceFiles();
const findings = [];

const detectors = [
  {
    name: 'personal home path',
    regex: /\/(?:data00\/)?home\/dengcanwen\b/g,
  },
  {
    name: 'real Feishu/Lark app id',
    regex: /\bcli_[A-Za-z0-9_-]{10,}\b/g,
    allow: (line) => line.includes('cli_xxx') || line.includes('cli_...'),
  },
  {
    name: 'real Feishu/Lark chat id',
    regex: /\boc_[A-Za-z0-9_-]{16,}\b/g,
    allow: (line) => line.includes('oc_xxx'),
  },
  {
    name: 'real Feishu/Lark user open id',
    regex: /\bopen_[A-Za-z0-9_-]{16,}\b/g,
    allow: (line) => line.includes('open_...') || line.includes('open_u1'),
  },
  {
    name: 'Anthropic/OpenAI style secret',
    regex: /\b(sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|plat_[A-Za-z0-9_-]{20,})\b/g,
  },
  {
    name: 'private key block',
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  },
  {
    name: 'non-placeholder larkAppSecret',
    regex: /"larkAppSecret"\s*:\s*"(?!REPLACE_|CHANGE_|xxx|X{3,})[^"]{12,}"/g,
  },
  {
    name: 'non-placeholder ANTHROPIC_AUTH_TOKEN',
    regex: /ANTHROPIC_AUTH_TOKEN\s*=\s*["']?(?!REPLACE_|CHANGE_|xxx|your_|example)[A-Za-z0-9._-]{12,}/g,
  },
];

for (const file of files) {
  if (skipFile(file)) continue;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const detector of detectors) {
      detector.regex.lastIndex = 0;
      if (!detector.regex.test(line)) continue;
      if (detector.allow?.(line, file)) continue;
      findings.push({ file, line: index + 1, name: detector.name });
    }
  }
}

if (findings.length > 0) {
  console.error('Open-source check failed. Potential private or secret data found:');
  for (const item of findings) {
    console.error(`  ${item.file}:${item.line} ${item.name}`);
  }
  if (scanIgnoredLocal) {
    console.error('\nThese may be expected ignored local credentials. Do not zip or publish the whole working tree; publish Git-tracked/release files only.');
  } else {
    console.error('\nFix these files before committing, publishing, or packaging.');
  }
  process.exit(1);
}

console.log(`Open-source check passed (${files.length} ${scanIgnoredLocal ? 'local' : 'release-surface'} files scanned).`);

function execGit(argv) {
  return execFileSync('git', argv, { encoding: 'utf8' });
}

function maybeExecGit(argv) {
  try {
    return execFileSync('git', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

function releaseSurfaceFiles() {
  if (gitRoot) return trackedFiles();
  return localFiles();
}

function trackedFiles() {
  return execGit(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
}

function localFiles() {
  return execFileSync('find', ['.', '-type', 'f', '-not', '-path', './.git/*', '-not', '-path', './node_modules/*'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((item) => item.replace(/^\.\//, ''));
}

function skipFile(file) {
  return file === 'package-lock.json'
    || file.endsWith('.png')
    || file.endsWith('.jpg')
    || file.endsWith('.jpeg')
    || file.endsWith('.gif')
    || file.endsWith('.webp')
    || file.endsWith('.ico')
    || file.endsWith('.tgz');
}
