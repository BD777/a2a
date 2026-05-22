# Minimal A2A image. Single Node process; all state in /root/.a2a.
# Build context is the repo root (see docker-compose.yml).

FROM node:20-bookworm-slim AS base

ARG CODEX_CLI_VERSION=0.133.0
ARG CLAUDE_CODE_VERSION=2.1.144

# `claude` and `codex` CLIs both ship binaries that may pull in build deps.
# Keep this list small — add packages here only when an install actually needs them.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install project deps first so they cache across source-only changes.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Globally install the two SDK-backing CLIs. Keep these pins intentional so a
# rebuild stays reproducible; bump them alongside runtime compatibility checks.
RUN npm install -g "@openai/codex@${CODEX_CLI_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

COPY src ./src
COPY scripts ./scripts
COPY workspaces ./workspaces
# config/ is mounted at runtime so credentials live on the host.

ENV A2A_HOME=/root/.a2a
ENV NODE_ENV=production

# Admin HTTP server. Only useful when --network=host or you publish the port
# explicitly; default is loopback-only and there is no auth.
EXPOSE 39876

CMD ["node", "src/index.js"]
