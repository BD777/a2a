# Feishu Permissions Audit

This document enumerates every Feishu API call A2A makes, and the tenant scope
that authorises each one. It exists so a tenant administrator can review what
A2A actually does before granting scopes to the apps.

## API surface

A2A touches three Feishu Open Platform namespaces:

- `im.v1` — message read/reply/delete.
- `contact.v3` — optional sender display-name lookup.
- `cardkit.v1` — optional streaming-card create/update APIs.

| API call | File:line | Scope required | Purpose |
|---|---|---|---|
| `client.im.v1.message.reply` | `src/feishu/client.js:30` | `im:message.group_msg` / `im:message:send_as_bot` | Post the agent's text or interactive card reply into the same Feishu thread. Feishu/Lark tenant consoles vary in how they label bot-send scopes; grant the bot-send/group-message permission shown by your tenant. |
| `client.im.v1.message.delete` | `src/feishu/client.js:48` | `im:message:recall` | Optional cleanup: delete A2A's own empty/overflow streaming cards and explicit `doctor --reply-test` probe messages. Runtime degrades by leaving the message in place if this is absent. |
| `client.cardkit.v1.card.create` | `src/feishu/client.js:59` | `cardkit:card:write` | Create the backing CardKit card used for live streaming output. Required only when `A2A_FEISHU_STREAMING=true`. |
| `client.cardkit.v1.cardElement.content` | `src/feishu/client.js:73` | `cardkit:card:write` | Stream text/thinking deltas into individual card elements. Required only when `A2A_FEISHU_STREAMING=true`. |
| `client.cardkit.v1.card.update` | `src/feishu/client.js:85` | `cardkit:card:write` | Replace the temporary streaming card with the final card. Required only when `A2A_FEISHU_STREAMING=true`. |
| `client.im.v1.message.get` | `src/feishu/client.js:110` | `im:message` | Resolve the root message's `thread_id` so we can list by thread instead of chat. |
| `client.im.v1.message.list` | `src/feishu/client.js:120` | `im:message` | Page messages by container (`thread` if available, else `chat`) to assemble the topic context the agents see at first turn. |
| `client.contact.v3.user.get` | `src/feishu/client.js:142` | `contact:user.base:readonly` | Look up a user's display name (`open_id` mode) so logs and prompts say `Alice (user:open_...)` instead of just `user:open_...`. Failures are swallowed; without this scope, A2A still works and sender labels degrade to raw open IDs. |

## Permission sets

Minimal non-streaming deployment:

- `im:message`
- `im:message.group_msg` / `im:message:send_as_bot`

Recommended single-tenant deployment:

- Minimal non-streaming scopes
- `contact:user.base:readonly`

Streaming-card deployment:

- Recommended scopes
- `cardkit:card:write`
- `im:message:recall` if you want A2A to delete its own empty/overflow
  streaming cards and `doctor --reply-test` probe replies.

## Event subscription

Exactly one event is subscribed, in `src/feishu/receiver.js:9`:

| Event | Why |
|---|---|
| `im.message.receive_v1` | Wakes the scheduler whenever any message lands in an owned chat. The receiver filters by `config.ownedChatIds` before passing it on, so messages in chats the bot is not configured to listen to are dropped before scheduling. |

## What A2A does **not** do

- It does not call drive / sheets / bitable / docx / calendar / approval / wiki
  / admin / application APIs.
- It does not create chats, manage members, or change app settings.
- It does not use HTTP callbacks; the receiver is WebSocket-only via
  `WSClient` (`src/feishu/receiver.js:32,61`). No public callback URL or
  encryption key is needed.
- It does not read messages from chats outside `config.ownedChatIds` — events
  for other chats are filtered before any scheduling logic runs.
- It does not message users outside the chats it has been explicitly added to;
  `reply_in_thread` always replies into the same chat the trigger came from.

## Local data the service stores

A2A persists state under `$A2A_HOME` (default `~/.a2a`). All files are JSON.

| Path | Contents |
|---|---|
| `~/.a2a/state/sessions.json` | Running sessions only (id, root msg, transcript so far). Deleted entries finalise into `sections.json`. |
| `~/.a2a/state/sections.json` | Per-thread metadata kept across restarts so resumed agents can reuse `threadId`. |
| `~/.a2a/state/seen-messages.json` | Message dedup ring (capped at 5000 IDs). |
| `~/.a2a/logs/a2a.log` | Text log mirror of journal output. |

No state is sent to any service other than the Feishu APIs listed above and the
configured Anthropic / Codex endpoints.
