#!/usr/bin/env bash
# Render the A2A systemd user unit from deploy/systemd/a2a.service.template
# and install it under ~/.config/systemd/user/. Idempotent.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
A2A_HOME="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMPLATE="${A2A_HOME}/deploy/systemd/a2a.service.template"
TARGET_DIR="${HOME}/.config/systemd/user"
TARGET="${TARGET_DIR}/a2a.service"

if [[ ! -f "${TEMPLATE}" ]]; then
  echo "error: template not found at ${TEMPLATE}" >&2
  exit 1
fi

NODE_BIN="${A2A_NODE_BIN:-$(command -v node || true)}"
if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
  echo "error: node executable not found on PATH; set A2A_NODE_BIN=/abs/path/to/node and retry" >&2
  exit 1
fi

if [[ "${A2A_SKIP_DOCTOR:-}" != "1" ]]; then
  echo "running local deployment preflight (set A2A_SKIP_DOCTOR=1 to skip)..."
  "${NODE_BIN}" "${A2A_HOME}/scripts/doctor.mjs" --fix-permissions
fi

mkdir -p "${TARGET_DIR}"
sed -e "s|__A2A_HOME__|${A2A_HOME}|g" \
    -e "s|__A2A_NODE__|${NODE_BIN}|g" \
    "${TEMPLATE}" > "${TARGET}"
echo "wrote ${TARGET} (node=${NODE_BIN})"

if grep -qE '__A2A_(HOME|NODE)__' "${TARGET}"; then
  echo "error: placeholder substitution failed; check sed delimiter" >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "warning: systemctl not found; unit installed but not enabled."
  exit 0
fi

systemctl --user daemon-reload
if [[ "${1:-}" == "--enable" || "${1:-}" == "-e" ]]; then
  systemctl --user enable --now a2a.service
  echo "a2a.service enabled and started."
else
  echo "Unit installed. To start now:"
  echo "  systemctl --user enable --now a2a.service"
fi
echo "Tail logs with:"
echo "  journalctl --user -u a2a.service -f"
