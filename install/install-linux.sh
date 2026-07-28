#!/bin/sh
# Spike installer — Linux.
#
# HOW TO USE: from a terminal in the download folder:
#     chmod +x install-linux.sh && ./install-linux.sh
# (Some desktops also let you mark it executable in the file manager's
# Properties → Permissions and run it on double-click.)
#
# This is SELF-CONTAINED — it does not fetch anything but the npm package. It:
#   1. Verifies Node.js >= 20 (the daemon is a Node process).
#   2. Installs the `spike` CLI globally from npm (spike-agent).
#   3. Registers `spike daemon` to auto-start on login (systemd --user) and starts
#      it now — so the browser extension's connection dot goes green, no terminal.
#
# Re-running is safe (idempotent). Everything is per-user; no sudo required.

set -eu

PKG_NAME='spike-agent'

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m[OK] %s\033[0m\n' "$1"; }
warn() { printf '\033[33m[!] %s\033[0m\n' "$1"; }

step 'Checking Node.js…'
if ! command -v node >/dev/null 2>&1; then
  warn 'Node.js was not found on your PATH.'
  echo '  Install Node 20+ from https://nodejs.org (or your package manager / nvm), then re-run this.'
  exit 1
fi
NODE_VERSION="$(node --version | sed 's/^v//')"
NODE_MAJOR="$(echo "$NODE_VERSION" | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  warn "Node $NODE_VERSION found, but the daemon needs Node 20+."
  echo '  Upgrade from https://nodejs.org and re-run this.'
  exit 1
fi
ok "Node $NODE_VERSION"

step "Installing the qa CLI globally (npm i -g $PKG_NAME)…"
export NODE_OPTIONS='--use-system-ca'
if ! npm install -g "$PKG_NAME"; then
  warn 'npm install failed.'
  echo '  If this is a permissions error (EACCES), see:'
  echo '  https://docs.npmjs.com/resolving-eacces-permissions-errors'
  exit 1
fi
ok 'qa CLI installed'

step 'Registering the daemon to auto-start on login…'
if ! spike daemon --install-service; then
  warn 'Could not register the auto-start service.'
  echo '  You can still start the daemon manually any time with:  spike daemon'
  exit 1
fi

echo ''
ok 'Done. Spike is running and will start on every login.'
echo '  Go back to the browser extension — the connection dot should turn green shortly.'
echo '  (On some distros you may need once:  loginctl enable-linger "$USER")'
echo '  To remove it later:  spike daemon --uninstall-service'
