# Setup Guide

This document walks you through getting A2A running from a fresh clone. Most of
the actual work is automated by `npm run setup`; this guide is the human
companion that explains the why and shows what each step looks like in the
Feishu console.

## Prerequisites

The exact dependency ledger lives in [docs/DEPENDENCIES.md](./DEPENDENCIES.md)
and `config/dependencies.json`. `npm run doctor` checks that ledger.

| Dependency | Required version / source | Why |
|---|---|---|
| **Node** | `>=20` | Service runtime, ESM features. |
| **npm** | `>=9` | Reproducible `npm ci` install from `package-lock.json`. |
| **Project npm packages** | `npm ci` installs `@anthropic-ai/claude-agent-sdk@0.3.148`, `@larksuiteoapi/node-sdk@1.65.0`, `@openai/codex-sdk@0.133.0`, and transitive `@openai/codex@0.133.0`. | Runtime SDKs and Feishu/Lark API client. |
| **`claude` CLI** | Tested with `@anthropic-ai/claude-code@2.1.144`; install with `npm install -g @anthropic-ai/claude-code@2.1.144` or set `A2A_CLAUDE_PATH`. | Claude turns. |
| **`codex` CLI** | Installed by `npm ci` as `node_modules/.bin/codex`; A2A prefers this local binary before system binaries. | Codex turns with SDK/CLI version alignment. |
| **Anthropic-compatible endpoint** | `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` | Claude Agent SDK credentials. |
| **Codex/OpenAI provider auth** | Codex CLI config/auth, usually under `~/.codex/` | Codex turns. |
| **A Feishu (Lark) tenant** | Permission to create custom apps | Where the bots live. |
| **`jq`, `curl`** | Optional | Pretty/admin convenience via `scripts/a2a-admin.sh`. |

For Lark international tenants, set `A2A_FEISHU_DOMAIN=lark` before running
`npm run setup`, `npm run doctor`, or the daemon. The default is
`A2A_FEISHU_DOMAIN=feishu`.

## Runtime parity: test both CLIs interactively first

A2A spawns `claude` and `codex` as child processes. **Whatever they can do in
your terminal is what they can do inside A2A** — A2A does not load extra
skills, MCP servers, or proxies on top. So before you install, walk through
this checklist:

1. **Run `claude` interactively** in the same shell you'll run A2A from. Try
   the kinds of things you want it to do in chat — fetching a Feishu doc URL,
   calling an internal API, etc. If a request needs a skill, MCP server, or
   environment variable, configure it in `~/.claude/settings.json` /
   `~/.claude/skills/` / your shell rc and verify it works **outside A2A
   first**.
2. **Run `codex` interactively** the same way. Codex reads
   `~/.codex/config.toml` and/or local auth state under `~/.codex/`.
   Verify the same flows work there too.
3. **Fix any asymmetry now.** If Claude can read a Feishu doc but Codex
   can't, A2A will reproduce that gap inside the chat. Common causes:
   - Claude reaches its tools by way of `~/.claude/settings.json`
     permissions (`bypassPermissions` is the unrestricted mode) plus
     whatever you've put under `~/.claude/skills/`.
   - Codex doesn't have a "skills" directory, but it can shell out to the
     same underlying CLIs (for example `feishu-cli`, `curl`, or your internal
     helper tools) when the sandbox allows it. Codex's hard default (no config file) is
     `sandbox_mode=read-only`, which blocks shell exec and outbound network
     — anything that calls `feishu-cli`, `curl`, or another helper fails
     until you raise it.

4. **A2A defaults to permissive on both sides.** Claude runs with
   `permissionMode=dontAsk` (≈ `bypassPermissions`) and Codex runs with
   `sandbox_mode=danger-full-access` + `approval_policy=never` +
   `web_search=live`. Both runtimes have full host reach out of the box —
   that's how Feishu CLIs, internal tools, and `curl` work end-to-end inside chat without
   extra wiring. **A2A overrides whatever is in `~/.codex/config.toml`
   here** unless you tell it not to. To lock down for shared / multi-tenant
   deployments, set the env vars in `deploy/a2a.env`:

   ```sh
   A2A_CLAUDE_PERMISSION_MODE=plan          # default | acceptEdits | plan | dontAsk
   A2A_CODEX_SANDBOX=workspace-write        # read-only | workspace-write | danger-full-access
   A2A_CODEX_APPROVAL=on-failure            # never | on-failure | always
   A2A_CODEX_WEB_SEARCH=off                 # live | off
   ```

   Setting `A2A_CODEX_SANDBOX=` (empty) tells A2A to fall through to
   `~/.codex/config.toml` instead — useful if you want one source of truth
   for the interactive CLI and the A2A daemon.

If both CLIs can do everything you need *outside* A2A, the bots in chat will
have the same reach. If something works in `claude` but not `codex` (or vice
versa) at the terminal, expect the same gap inside the Feishu thread — fix
the per-CLI config first.

## 1. Create two Feishu apps

A2A runs as **two distinct bots** in the same chat — one for Claude, one for
Codex — so they can be addressed separately and coloured differently in cards.

For each agent (`claude-code`, `codex`):

1. Open <https://open.feishu.cn/app> and click **创建企业自建应用** (Create Custom App).
2. Give it a name (e.g. `A2A · Claude`), an icon, and a description.
3. Open **应用功能 → 机器人** (Application Capabilities → Bot) and **add a bot**
   to the app. The bot is what posts cards into chats.
4. Open **事件与回调 → 事件配置** (Events & Callbacks → Event Subscriptions).
   - Switch the **请求方式** (request mode) to **长连接 / Long Connection**.
     A2A uses WebSocket-only and does not need a public callback URL or
     encryption key.
   - Add the event **`im.message.receive_v1`** (接收消息 v2.0). This is the
     only event A2A subscribes to.
5. Open **权限管理** (Permissions) and enable the scopes in
   [docs/PERMISSIONS.md](./PERMISSIONS.md). The minimal set is:
   - `im:message` *(read messages, resolve threads, download incoming image resources)*
   - `im:message.group_msg` / `im:message:send_as_bot` *(console naming varies)*
   - `contact:user.base:readonly` *(optional — see permissions doc)*
   - `cardkit:card:write` *(only if `A2A_FEISHU_STREAMING=true`)*
   - `im:message:recall` *(optional cleanup permission for deleting A2A's own probe/empty streaming messages)*
6. Open **版本管理与发布** (Versions & Releases) and **publish a new version**.
   *Permissions and event subscriptions don't take effect until the app version
   is published, even for self-tenant deployments.*
7. Open **凭证与基础信息** (Credentials & Basic Info) and copy the **App ID**
   (`cli_…`) and **App Secret**. You'll paste these into the wizard.
8. Add the bot to whichever Feishu chats you want A2A to listen on. The bot
   only sees messages in chats it has been added to.

Repeat for the second agent. The two apps don't have to share names or scopes
beyond what's listed above, but they **must** both subscribe to
`im.message.receive_v1`.

## 2. Find chat IDs

A2A only listens on chats whose IDs you list in `config/chats.json`. Two ways
to get an `oc_…` ID:

- **Desktop client**: right-click the chat → **复制群 ID** / **Copy chat ID**.
- **CLI** (if you have it installed):
  ```sh
  feishu-cli msg search-chats --query "<chat name keyword>" -o json
  ```

The wizard will prompt for these. You can also skip and edit `config/chats.json`
manually later.

## 3. Run the wizard

```sh
git clone https://github.com/BD777/a2a.git
cd a2a
npm ci
npm run setup
npm run doctor
```

The wizard does seven things:

1. **Preflight** — checks Node version and warns if `claude` / `codex` are
   missing. A2A prefers the repository-local `node_modules/.bin/codex` installed
   by `npm ci` before falling back to a system `codex`, so the SDK and CLI stay
   version-aligned by default.
2. **Provisioning guide** — reminds you of the Feishu console steps above.
3. **Credentials** — prompts for App ID / App Secret per agent and **validates
   each pair** by calling
   `POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal`.
   If Feishu returns a non-zero `code`, you see the message and can re-enter
   without restarting the wizard.
4. **Chat IDs** — collects `oc_…` IDs interactively.
5. **Anthropic relay env** — prompts for `ANTHROPIC_BASE_URL`,
   `ANTHROPIC_AUTH_TOKEN`, optional model overrides, then writes
   `config/profiles/claude-relay.env` (chmod 600).
6. **Writes configs** — `config/agents.json`, `config/chats.json`,
   `config/profiles/claude-relay.env`. Existing files are never silently
   overwritten; you must confirm.
7. **Next steps** — prints how to run locally or install as a user systemd
   service.

Then `npm run doctor` verifies the local runtime is actually usable: Node
version, npm dependencies, discovered `claude` / `codex` binaries, config file
shape, local working directories, Claude profile env, Codex config/auth
presence, and private file modes. Use:

```sh
npm run doctor -- --fix-permissions
npm run doctor -- --online
```

The online mode validates Feishu credentials and confirms each bot can read the
configured chats. It does not send messages unless you explicitly pass
`--reply-test <message_id>`.

## 4. Verify it boots

```sh
npm run check    # syntax-check src/
npm test         # unit tests, no network required
npm run doctor   # local config/dependency readiness
node src/index.js
```

A healthy first line in the log looks like:

```
[INFO] A2A ready. ownedChats=oc_xxx... agents=claude-code -> codex receiver=claude-code
[INFO] Feishu WS connected for claude-code (cli_...)
```

Send a plain message in one of the listed chats. Within a few seconds the
claude-code bot should reply with a blue card; codex follows with a turquoise
one. If nothing happens, check:

- **Bot was added to the chat?** The bot must be a member.
- **App version was published?** Scopes silently fail without a version.
- **`im.message.receive_v1` is subscribed?** Without the event the bot never
  sees your message.

## 5. Install as a systemd user service (optional)

```sh
scripts/install-systemd.sh --enable
journalctl --user -u a2a.service -f
```

The script first runs `scripts/doctor.mjs --fix-permissions`, then renders
`deploy/systemd/a2a.service.template` (which uses an `__A2A_HOME__`
placeholder) into `~/.config/systemd/user/a2a.service` with the absolute path
of your checkout substituted in, runs `daemon-reload`, and optionally
enables/starts the unit. Set `A2A_SKIP_DOCTOR=1` only when you intentionally
want to bypass this local preflight.

Re-run the script any time you move the checkout.

## 6. Tuning knobs

Edit `deploy/a2a.env` (or set env vars another way) and restart the service:

```sh
systemctl --user restart a2a.service
```

See `deploy/a2a.env.example` for the full list. Common ones:

- `A2A_FEISHU_CARD=false` — fall back to plain-text replies (no markdown render).
- `A2A_MAX_TURNS_SINCE_USER=20` — raise the auto-debate ceiling.
- `A2A_LOG_FORMAT=json` — structured logs for ingestion.
- `A2A_SESSION_TIMEOUT_MS=14400000` — hard 4-hour session ceiling.
- `A2A_ATTACHMENTS_ENABLED=false` — disable image downloads; agents will see
  `[image]` text placeholders only.
- `A2A_ATTACHMENT_MAX_BYTES=26214400` — per-image download limit.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Feishu WS connected` then nothing on user message | Bot not in the chat, or chat ID not in `config/chats.json`. |
| `code=99991663 / token invalid` | App version not published, or App Secret rotated since setup. |
| `code=99991672 / app permission denied` | Required scope missing; re-check `docs/PERMISSIONS.md`. |
| Card looks plain / no header colour | Set `A2A_FEISHU_CARD=true` (default) and confirm `replyMessage` calls aren't being downgraded by an upstream proxy. |
| Streaming card creation fails | Enable `cardkit:card:write`, publish a new app version, then run `npm run doctor -- --online --streaming`. |
| Agents only see `[image]` | Confirm `A2A_ATTACHMENTS_ENABLED=true`, the app has `im:message`, the bot is in the chat, and the image is below `A2A_ATTACHMENT_MAX_BYTES`. |
| Reply works but doctor cannot delete the probe | Optional cleanup scope `im:message:recall` is missing. Runtime still works; empty/overflow streaming cards may remain visible. |
| Repeated `WS disconnected ... giving up` | Network blocks `wss://lark-event-ws.feishu.cn`. Run from a host that can reach Feishu's WS endpoint. |
