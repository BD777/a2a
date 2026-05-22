# Deploying A2A

A2A is a single Node process; all state lives in `$A2A_HOME` (default `~/.a2a`)
and config lives in `<repo-root>/config`. Pick whichever supervisor fits your
environment.

All external dependencies are listed in [docs/DEPENDENCIES.md](../docs/DEPENDENCIES.md)
and `config/dependencies.json`. Run `npm run doctor` after `npm ci` to verify
that the host matches that ledger.

## Option 1 — bare process (dev / quick try)

```sh
npm ci
npm run setup       # one-time interactive wizard
npm run doctor      # local dependency/config preflight
node src/index.js
```

The process logs to stdout and to `~/.a2a/logs/a2a.log`. It auto-resumes any
sessions whose `running` state survived the previous shutdown by reading
`~/.a2a/state/sessions.json`.

## Option 2 — systemd user service (Linux)

```sh
scripts/install-systemd.sh --enable
journalctl --user -u a2a.service -f
```

The script runs `scripts/doctor.mjs --fix-permissions`, then renders
`deploy/systemd/a2a.service.template`, substituting the repo root and the
`node` binary it finds via `command -v node` (override with
`A2A_NODE_BIN=/abs/path/to/node`). Drop your env tweaks into
`<repo-root>/deploy/a2a.env` (copy from `deploy/a2a.env.example`) — the unit
loads it via `EnvironmentFile=`.

Set `A2A_SKIP_DOCTOR=1` only if you intentionally want to install the unit
before local dependencies/config are ready.

To run as a non-login user, switch the unit to `[Service] Type=simple`
under `/etc/systemd/system/` and adjust `User=` / `Group=` /
`WorkingDirectory=` accordingly.

## Option 3 — pm2

```sh
npm install -g pm2
npm ci
npm run doctor
pm2 start src/index.js --name a2a --interpreter node \
  --update-env --watch=false \
  --env-file deploy/a2a.env
pm2 save
pm2 startup            # follow the printed sudo command to persist across reboots
pm2 logs a2a
```

To pin Node:

```sh
pm2 start src/index.js --name a2a --interpreter "$(which node)"
```

## Option 4 — Docker / docker-compose

A minimal image is provided under `deploy/docker/`. Run the wizard on the
host first (it asks interactive questions and validates Feishu credentials),
then bring the container up:

```sh
npm ci && npm run setup && npm run doctor        # one-time, on the host
cd deploy/docker
docker compose up -d --build
docker compose logs -f a2a
```

The compose file mounts `<repo>/config` (read-only) and a named volume for
`~/.a2a` state, so credentials and runtime state survive container rebuilds.
The image bakes Node 20, the project, and globally installs the `claude` and
`codex` CLIs; you still have to provide their credentials via
`config/profiles/claude-relay.env` (created by the wizard) and any
provider-specific files mounted under `/root/.config`.

Codex turns also need provider auth/config inside the container. Pick one:

- Bind-mount an already-working host config, e.g.
  `${HOME}/.codex:/root/.codex:ro`.
- Or uncomment the `a2a-codex:/root/.codex` named volume and initialize it by
  running the Codex CLI/login flow inside the container once.

The Docker build uses `npm ci --omit=dev` and pinned global CLI versions via
build args in `deploy/docker/docker-compose.yml`. Bump those args deliberately
when upgrading agent runtimes.

To customize env without rebuilding the image, copy
`deploy/a2a.env.example` → `deploy/a2a.env` and uncomment the `env_file:`
block in `deploy/docker/docker-compose.yml`.

### Caveats

- The Docker container talks to Feishu via outbound WebSocket (no inbound
  ports needed). Make sure your network allows egress to
  `wss://oapi.feishu.cn`.
- Codex CLI authentication state lives in `~/.codex` inside the container.
  The compose file does not mount host `~/.codex` by default; add the bind
  mount or initialize the named volume before expecting Codex turns to work.
- Claude Agent SDK reads its env from `config/profiles/claude-relay.env` on
  every turn — it does not need a separate filesystem login state.

## Promoting to production

Whatever supervisor you pick, plan for these:

- **Backups**: nightly snapshot of `$A2A_HOME/state/` (sessions, sections,
  dedup ring). State is JSON, so `cp` is enough.
- **Log rotation**: stdout / journald already rotates; if you keep
  `~/.a2a/logs/a2a.log`, run logrotate or pipe through `multilog`.
- **Health check**: `curl -fsS http://127.0.0.1:39876/health` returns 200
  when the HTTP admin server is up. (Bind only to loopback unless you put
  an auth proxy in front of it.)
- **Post-provision validation**: `npm run doctor -- --online` validates Feishu
  App ID/Secret pairs and confirms each bot can read each configured chat.
  Add `--streaming` to verify CardKit permissions, and
  `--reply-test <message_id>` only when you intentionally want to post and
  delete a probe reply.
- **Restarts**: any non-zero exit means the WS supervisor decided to give
  up — relaunching usually clears it. systemd's `Restart=always` and pm2's
  default behavior both handle this.
