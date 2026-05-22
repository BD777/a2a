#!/usr/bin/env bash
# A2A admin CLI. Talks to the localhost-only admin endpoints.
#
# Usage:
#   scripts/a2a-admin.sh list
#   scripts/a2a-admin.sh stop <sessionId> [reason]

set -euo pipefail

HOST="${A2A_ADMIN_HOST:-127.0.0.1}"
PORT="${A2A_ADMIN_PORT:-39876}"
BASE="http://${HOST}:${PORT}"

cmd="${1:-}"
case "$cmd" in
  list)
    curl -fsS "${BASE}/sessions" | (jq . 2>/dev/null || cat)
    ;;
  stop)
    sid="${2:?usage: stop <sessionId> [reason]}"
    reason="${3:-admin-stop}"
    curl -fsS -X POST "${BASE}/sessions/${sid}/stop" \
      -H 'content-type: application/json' \
      -d "{\"reason\":\"${reason}\"}" | (jq . 2>/dev/null || cat)
    ;;
  health)
    curl -fsS "${BASE}/health" | (jq . 2>/dev/null || cat)
    ;;
  *)
    cat <<USAGE
A2A admin CLI

Commands:
  list                       List running sessions
  stop <sessionId> [reason]  Stop a running session
  health                     Check the service is up

Env:
  A2A_ADMIN_HOST=127.0.0.1
  A2A_ADMIN_PORT=39876
USAGE
    exit 1
    ;;
esac
