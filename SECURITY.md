# Security Policy

## Supported Versions

Only the current `main` branch is supported until the project starts publishing
tagged releases.

## Reporting A Vulnerability

Please report security issues privately to the repository owner before opening a
public issue. Include:

- The affected commit or version.
- Whether the issue affects local-only configuration, Feishu/Lark permissions,
  agent runtime execution, or published package contents.
- A minimal reproduction when possible.

## Local Secrets

A2A stores real credentials in ignored local files:

- `config/agents.json`
- `config/chats.json`
- `config/profiles/*.env`
- `deploy/a2a.env`

Run `npm run doctor -- --fix-permissions` to keep those files at mode `600` on
POSIX systems. If a real secret is ever committed or pushed, rotate it in the
provider console and rewrite the repository history before publishing.

## Runtime Posture

By default A2A runs Claude and Codex with broad host access so both agents can
use the same local CLIs and network paths you verified interactively. For shared
or multi-tenant hosts, restrict:

```sh
A2A_CLAUDE_PERMISSION_MODE=plan
A2A_CODEX_SANDBOX=workspace-write
A2A_CODEX_APPROVAL=on-failure
A2A_CODEX_WEB_SEARCH=off
```

The admin HTTP server is unauthenticated and should stay bound to loopback
unless an authenticated reverse proxy is placed in front of it.
