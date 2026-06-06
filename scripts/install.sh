#!/usr/bin/env bash
#
# vps-agent installer.
#
# Installs the SprintFlint VPS agent globally via npm and prints next steps.
# Works on Linux and macOS. Requires Node.js >= 18 and npm on PATH.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/sprintflint/vps-agent/main/scripts/install.sh | bash
#   # or, from a checkout:
#   ./scripts/install.sh
#
set -euo pipefail

PACKAGE="vps-agent"
MIN_NODE_MAJOR=18

err() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
info() { printf '\033[36m%s\033[0m\n' "$*"; }
ok() { printf '\033[32m%s\033[0m\n' "$*"; }

# --- prerequisites ----------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  err "Node.js is not installed. Install Node.js >= ${MIN_NODE_MAJOR} from https://nodejs.org and re-run."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  err "npm is not installed (it ships with Node.js). Install Node.js >= ${MIN_NODE_MAJOR} and re-run."
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  err "Node.js ${MIN_NODE_MAJOR}+ is required; found $(node -v). Please upgrade."
  exit 1
fi

# --- install ----------------------------------------------------------------
info "Installing ${PACKAGE} globally via npm..."
if npm install -g "${PACKAGE}"; then
  ok "Installed."
else
  err "Global install failed."
  err "If this is a permissions error, either configure an npm prefix you own"
  err "(see https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally)"
  err "or re-run with sudo: sudo npm install -g ${PACKAGE}"
  exit 1
fi

# --- verify -----------------------------------------------------------------
if command -v vps-agent >/dev/null 2>&1; then
  ok "vps-agent $(vps-agent --version) is on your PATH."
else
  err "vps-agent installed but is not on PATH. Add your npm global bin dir (\`npm bin -g\`) to PATH."
fi

cat <<'EOF'

Next steps:
  1. Register this VPS:
       vps-agent register --org-id <your-org-id> --name "$(hostname)"
     or, with a token created in the SprintFlint web UI:
       vps-agent register --token <runner-token>
  2. Check prerequisites (git, gh, claude):
       vps-agent doctor
  3. Start the agent in the background:
       vps-agent start --daemon
  4. Watch it work:
       vps-agent status
       vps-agent logs -f

EOF
