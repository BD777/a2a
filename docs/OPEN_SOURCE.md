# Open-Source Readiness Checklist

Use this checklist before making a fork or release public.

## Required Checks

```sh
npm ci
npm run ci
npm run doctor
npm run doctor -- --online
npm pack --dry-run
```

Before changing runtime packages, CLI versions, Feishu/Lark scopes, or required
network services, update both `config/dependencies.json` and
`docs/DEPENDENCIES.md`.

Run the explicit reply probe only in a chat where a small test message is
acceptable:

```sh
npm run doctor -- --online --reply-test <Feishu message_id>
```

This validates bot send permission and attempts to delete the probe reply.

## Secrets And Personal Data

- Commit only `.example` config files.
- Keep real `config/agents.json`, `config/chats.json`,
  `config/profiles/*.env`, `deploy/a2a.env`, rendered systemd units, logs, and
  workspace scratch files out of Git. Runtime image caches under
  `$A2A_HOME/attachments` are local data and must not be published.
- Run `npm run open-source:check` before committing.
- Run `npm run open-source:check -- --all-local` before zipping or copying the
  full working tree; it should flag real local credentials if the repo is
  configured.
- Run a history-aware scanner such as `gitleaks detect --log-opts --all` or
  `trufflehog git file://$PWD` before publishing an existing private history.
  If a real secret was ever committed, rotate it and rewrite history before
  publishing.

## Feishu/Lark Tenant Readiness

- Two custom apps exist, one for each agent.
- Each app has a bot enabled and added to the target chats.
- Each app subscribes to `im.message.receive_v1` using Long Connection mode.
- Each app version is published after permissions/events are changed.
- Minimal scopes are granted for non-streaming deployments.
- `cardkit:card:write` is granted before enabling `A2A_FEISHU_STREAMING=true`.
- Optional delete/recall permission is granted if you want A2A to remove its own
  empty/overflow streaming cards or doctor probe replies.

## Repository Hygiene

- `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, CI, issue template, and PR
  template are present.
- `docs/PERMISSIONS.md` matches every Feishu/Lark API call in `src/feishu`.
- Docker builds use reproducible dependency install (`npm ci`) and pinned
  global CLI versions.
- The public package tarball contains docs, examples, scripts, source, and
  tests, but no real config or runtime state.
