# A2A — Feishu topic scheduler for Claude × Codex

Lightweight Feishu (Lark) bot that runs **Claude Agent SDK** and **Codex SDK**
in turn-based discussion over an IM thread. Both agents read the same topic,
take alternating turns, and reply back into the same Feishu thread as
formatted cards.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
Repo: <https://github.com/BD777/a2a>

## Quick start

```sh
git clone https://github.com/BD777/a2a.git
cd a2a
npm ci
npm run setup        # interactive wizard: provisioning guide, credential validation, config write
npm run doctor       # local dependency/config readiness check
node src/index.js    # run locally, or use scripts/install-systemd.sh for a user service
```

The wizard takes 5–10 minutes and walks you through Feishu app creation,
verifies each `App ID` / `App Secret` against `tenant_access_token`, and
writes all config files for you.

For the full Feishu console flow and post-setup validation commands, see
**[docs/SETUP.md](docs/SETUP.md)**.

For the exact dependency ledger, including npm packages, CLI tools, external
services, and Feishu/Lark scopes, see **[docs/DEPENDENCIES.md](docs/DEPENDENCIES.md)**.

## Prerequisites

- **Node ≥ 20**
- **`claude` CLI** — backs the Claude runtime; tested with `@anthropic-ai/claude-code@2.1.144`
- **`codex` CLI** — backs the Codex runtime; installed by `npm ci` as `node_modules/.bin/codex`
- **Anthropic-compatible endpoint** — direct API key, or a relay
- **Feishu tenant** with permission to create custom apps in
  <https://open.feishu.cn/app>

Lark international tenants should set `A2A_FEISHU_DOMAIN=lark`; Feishu is the
default.

## Required Feishu scopes

| Scope | Why | Mandatory? |
|---|---|---|
| `im:message` | Read messages, resolve thread IDs, download image resources from messages | yes |
| `im:message.group_msg` / `im:message:send_as_bot` | Post threaded replies as the bot. Feishu/Lark consoles may show one or both names depending on tenant/version. | yes |
| `contact:user.base:readonly` | Resolve sender display names in logs/prompts | optional — degrades gracefully without it |
| `cardkit:card:write` | Create/update CardKit cards for `A2A_FEISHU_STREAMING=true` | required only when streaming cards are enabled |
| `im:message:recall` | Delete A2A's own empty/overflow streaming probe messages and `doctor --reply-test` replies | optional — cleanup degrades to leaving the message in place |

Subscribe exactly one event: `im.message.receive_v1`. Use **Long Connection**
(WebSocket) mode — A2A does not use HTTP callbacks, so no public URL is needed.

Full audit (scope ↔ source line) in [docs/PERMISSIONS.md](docs/PERMISSIONS.md).

## Layout

```
src/
  feishu/        WS receiver, ingress, publisher (cards + chunking), client pool
  scheduler/     turn order, dedupe, quiet/turn caps, session timeout, /a2a commands
  runtime/       Claude + Codex SDK adapters, retry/backoff
  protocol/      prompts, structured output parsing
  store/         JSON persistence under $A2A_HOME (default ~/.a2a)
config/          examples; real agents.json + chats.json + profile env stay local
deploy/systemd/  user-service template (rendered by scripts/install-systemd.sh)
docs/            architecture, setup, permissions
scripts/         setup wizard, install helper, admin CLI
test/            node --test unit tests (npm test)
workspaces/      stable cwd roots for the two SDKs
```

## Talking to it

In any chat listed in `config/chats.json`:

- **Start**: send any non-`/` message. The two-agent loop begins; replies post
  back in the same Feishu thread.
- **Send updates mid-loop**: every user message inside a running thread is
  appended to `userUpdates` and resets `turnsSinceUser`.
- **Stop**: `/a2a stop` (also `/a2a cancel`, `/a2a end`).
- **Status**: `/a2a status` — current waiting agent, turn count, quiet streak.

Slash commands that are not `/a2a …` are ignored.

## Safety limits (all configurable)

| Setting | Env | Default | What it bounds |
|---|---|---|---|
| `turnTimeoutMs` | `A2A_TURN_TIMEOUT_MS` | 7200000 | Single agent turn timeout (2 hours — long internal searches should finish instead of restarting) |
| `turnRetry.attempts` | `A2A_TURN_RETRY_ATTEMPTS` | 3 | Retries on transient errors (network / 5xx / 429 / timeouts) |
| `turnRetry.baseMs` / `capMs` | `A2A_TURN_RETRY_BASE_MS` / `_CAP_MS` | 2000 / 30000 | Exponential backoff bounds |
| `sessionTimeoutMs` | `A2A_SESSION_TIMEOUT_MS` | 14400000 | Hard session ceiling (4 hours) |
| `maxTurnsSinceUser` | `A2A_MAX_TURNS_SINCE_USER` | 100 | Quiets the loop if both agents keep talking without a user update |
| `quietStreak` | (none) | `agentOrder.length` | Stops once every agent returns empty in a row |
| `feishuChunkLimit` | `A2A_FEISHU_CHUNK_LIMIT` | 3500 | Per-reply char cap (text mode only) |
| `feishuCardByteLimit` | `A2A_FEISHU_CARD_BYTE_LIMIT` | 4500 | Per-card byte cap; long content split with fence rebalancing |
| `feishuCardEnabled` | `A2A_FEISHU_CARD` | true | Set false to fall back to plain text |
| `feishuStreaming` | `A2A_FEISHU_STREAMING` | false | Typewriter streaming for assistant text + thinking. Requires the Feishu app to have the `cardkit:card:write` scope; degrades gracefully to non-streaming if not. |
| `feishuStreamTextMs` | `A2A_FEISHU_STREAM_TEXT_MS` | 800 | Throttle for the body-element flush (Lark allows ~5 QPS per card) |
| `feishuStreamThinkMs` | `A2A_FEISHU_STREAM_THINK_MS` | 1500 | Throttle for the thinking-element flush |
| `feishuPageSizeCap` | `A2A_FEISHU_PAGE_SIZE_CAP` | 50 | Max page size sent to Feishu `im.message.list` (Lark caps at 50) |
| Codex SSE error log | `A2A_CODEX_SSE_ERROR_LOG` | `~/.codex/modelhub-proxy/sse-errors.log` | Local Codex backend diagnostics used to surface real `response.failed` reasons |
| `seenMessageLimit` | `A2A_SEEN_MESSAGE_LIMIT` | 5000 | De-dup ring for incoming Feishu message IDs |
| `attachmentsEnabled` | `A2A_ATTACHMENTS_ENABLED` | true | Download Feishu image resources so Claude/Codex receive real visual input instead of `[image]` placeholders |
| `attachmentsDir` | `A2A_ATTACHMENTS_DIR` | `~/.a2a/attachments` | Local cache for downloaded message images |
| `attachmentImageLimit` | `A2A_ATTACHMENT_IMAGE_LIMIT` | 12 | Max images attached to a single agent turn |
| `attachmentMaxBytes` | `A2A_ATTACHMENT_MAX_BYTES` | 26214400 | Max bytes per downloaded image |
| Admin HTTP bind | `A2A_EVENT_HOST` / `A2A_EVENT_PORT` | 127.0.0.1 / 39876 | Where the admin server listens (host-only, no auth) |
| WS reconnect cap | `A2A_WS_RECONNECT_GIVEUP` / `_MS` | 10 / 300000 | Exit (supervisor restarts) if WS gives up |
| Log format / level | `A2A_LOG_FORMAT` / `A2A_LOG_LEVEL` | text / info | `json` for structured logs |

## Admin endpoints

Bound to `127.0.0.1:39876` (no auth — host-only):

```sh
# list running sessions
curl -s http://127.0.0.1:39876/sessions | jq

# stop a session by id
curl -s -X POST http://127.0.0.1:39876/sessions/<sessionId>/stop \
  -H 'content-type: application/json' \
  -d '{"reason":"admin-stop"}'
```

Convenience wrapper: `scripts/a2a-admin.sh list | stop <sessionId> [reason] | health`.

## State files

- `~/.a2a/state/sessions.json` — only `running` sessions; finished ones move to `sections.json`.
- `~/.a2a/state/sections.json` — per-thread metadata kept across restarts so resumed agents can reuse `threadId`.
- `~/.a2a/state/seen-messages.json` — message dedup ring (capped at 5000 IDs).
- `~/.a2a/attachments/` — local cache of Feishu image resources attached to agent turns.
- `~/.a2a/logs/a2a.log` — text log mirror of journal output.

## Localizing prompts and lifecycle messages

A2A's user-facing strings (system cards like "A2A stopped (xxx)" and the
agent intro prompt) live in `src/protocol/messages.js`. To override any of
them — for a Chinese deployment, or just to tweak wording — drop a JSON
file at `config/messages.json` (or point `A2A_MESSAGES_FILE` elsewhere):

```json
{
  "lifecycle.start": "A2A 已启动 ({sessionId})。",
  "lifecycle.maxTurns": "A2A 在 {maxTurnsSinceUser} 轮后停止。"
}
```

Only the keys you list are overridden; everything else falls back to the
English defaults. Placeholders in `{curlyBraces}` are substituted at render
time. See `config/messages.zh-CN.example.json` for a complete sample.

## Architecture

See [docs/architecture.md](docs/architecture.md) for the full diagram, session
state shape, retry semantics, and termination conditions.

## Deployment

Bare process / systemd / pm2 / Docker recipes are in
[deploy/DEPLOYMENT.md](deploy/DEPLOYMENT.md), along with backup, log-rotation,
and health-check guidance.

## Release hygiene

Before publishing or packaging a fork:

```sh
npm run ci
npm run doctor -- --online          # validates Feishu credentials + chat read access
npm run open-source:check           # tracked + untracked non-ignored files
```

Run `npm run open-source:check -- --all-local` before zipping a whole working
tree; it intentionally scans ignored local credentials too.

See [docs/OPEN_SOURCE.md](docs/OPEN_SOURCE.md) for the full release checklist.

## License

MIT — see [LICENSE](LICENSE).
