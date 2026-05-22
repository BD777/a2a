# Contributing

Thanks for helping improve A2A. The project is intentionally small: one Node
process, JSON config, Feishu/Lark APIs, and two agent runtime adapters.

## Local Checks

Run these before opening a pull request:

```sh
npm ci
npm run check
npm test
npm run open-source:check
npm audit --omit=dev
```

Use `npm run doctor` after `npm run setup` when you want to verify that your
local runtime, config files, and optional deployment environment are usable.

## Secrets And Local Config

Do not commit real Feishu/Lark App IDs, App Secrets, chat IDs, agent auth
tokens, local workspace paths, or rendered systemd units. Real local files are
ignored by `.gitignore`; commit only `.example` files.

For a local-only scan that also checks ignored files, run:

```sh
npm run open-source:check -- --all-local
```

That command is expected to fail on a configured workstation because it will
detect real ignored credentials. It is useful before zipping or copying the
whole directory.

## Pull Request Shape

- Keep behavior changes covered by focused `node --test` tests.
- Update `docs/PERMISSIONS.md` whenever a Feishu/Lark API call is added,
  removed, or made conditional.
- Update `config/dependencies.json` and `docs/DEPENDENCIES.md` whenever an
  external dependency, runtime CLI, network service, or required scope changes.
- Update `deploy/a2a.env.example` and `docs/SETUP.md` whenever a runtime or
  environment variable changes.
- Avoid committing generated state, logs, rendered systemd units, or local
  runtime auth directories.
