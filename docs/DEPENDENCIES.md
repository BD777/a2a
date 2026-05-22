# Dependency Ledger

This file is the human-readable dependency ledger for A2A. The machine-readable
source is `config/dependencies.json`, and `npm run doctor` checks against it.

## Required System Runtime

| Dependency | Required version | Installed by | Why |
|---|---:|---|---|
| Node.js | `>=20` | OS package manager, nvm, fnm, Volta, or Node installer | Runs the A2A service and all setup/doctor scripts. |
| npm | `>=9` | Bundled with Node or installed with Node tooling | Runs `npm ci`, scripts, and package audit. |

Use `npm ci`, not a best-effort global install, for reproducible project
dependencies.

## Required npm Packages

These are installed from `package-lock.json` by `npm ci`.

| Package | Expected version | Why |
|---|---:|---|
| `@anthropic-ai/claude-agent-sdk` | `0.3.148` | Claude runtime adapter. |
| `@larksuiteoapi/node-sdk` | `1.65.0` | Feishu/Lark REST APIs, message-resource downloads, and Long Connection WebSocket receiver. |
| `@openai/codex-sdk` | `0.133.0` | Codex runtime adapter. |
| `@openai/codex` | `0.133.0` | Codex CLI binary used by the SDK; installed transitively by `@openai/codex-sdk` and exposed as `node_modules/.bin/codex`. |
| `axios` | `1.16.1` | Transitive dependency of `@larksuiteoapi/node-sdk`; pinned through `overrides` for audit hygiene. |

## Required Agent CLIs

| CLI | Expected source | Tested version | How A2A finds it |
|---|---|---:|---|
| `claude` | `@anthropic-ai/claude-code` | `2.1.144` | `A2A_CLAUDE_PATH`, then common user/system install paths. |
| `codex` | `@openai/codex` | `0.133.0` | `A2A_CODEX_PATH`, then `node_modules/.bin/codex`, then common user/system install paths. |

`codex` is intentionally project-local by default so the SDK and CLI versions
stay aligned. `claude` is still an external CLI today; install it explicitly:

```sh
npm install -g @anthropic-ai/claude-code@2.1.144
```

If you use a different Claude CLI version, `doctor` will warn when it is older
than the tested version but will not block startup.

## Optional Local Commands

| Command | Why |
|---|---|
| `curl` | `scripts/a2a-admin.sh` convenience calls. |
| `jq` | Pretty output for `scripts/a2a-admin.sh`. |
| `systemctl` | systemd user-service deployment. |
| `docker` / `docker compose` | Docker deployment option. |
| `pm2` | pm2 deployment option. |

## Required External Services

| Service | Hosts / config | Why |
|---|---|---|
| Feishu/Lark Open Platform REST | `open.feishu.cn` or `open.larksuite.com`; select with `A2A_FEISHU_DOMAIN=feishu` / `lark` / custom URL | App credential validation, IM message/resource, CardKit, and Contact API calls. |
| Feishu/Lark Long Connection WebSocket | Feishu/Lark event WebSocket endpoints such as `oapi.feishu.cn` / `lark-event-ws.feishu.cn` | Receive `im.message.receive_v1` events. |
| Anthropic-compatible endpoint | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` | Claude turns. |
| Codex/OpenAI provider endpoint | Codex CLI auth/config, usually under `~/.codex/` | Codex turns. |

## Required Feishu/Lark Provisioning

A2A requires two custom Feishu/Lark apps, one per agent. For each app:

- Bot capability enabled.
- Bot added to each target chat.
- Long Connection event subscription enabled.
- Event `im.message.receive_v1` subscribed.
- App version published after every permission/event change.

Required scopes:

- `im:message` for reading messages, resolving thread IDs, and downloading
  message image resources.
- `im:message.group_msg` / `im:message:send_as_bot`

Conditional scopes:

- `contact:user.base:readonly` for sender display names.
- `cardkit:card:write` when `A2A_FEISHU_STREAMING=true`.
- `im:message:recall` if you want A2A to delete its own empty/overflow/probe
  messages.

## Verification Commands

```sh
npm ci
npm run doctor
npm run doctor -- --online
npm run doctor -- --online --streaming
npm run ci
```

The only online command above is `doctor --online`; it validates Feishu
credentials and read/CardKit access without sending chat messages. Use
`--reply-test <message_id>` only when you intentionally want to post a probe
reply.

`doctor` checks that Codex config/auth state is present on the host, but it does
not spend provider tokens. Verify `codex` works interactively on a new machine
before starting the daemon.
