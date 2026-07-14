#!/bin/sh
# QA Subagent — one-line desktop-app installer (macOS / Linux)
#
# Usage (from the extension's "Connect desktop app" button, or by hand):
#     curl -fsSL https://raw.githubusercontent.com/uvesarshad/browser-qa-subagent/main/install/install.sh | sh
#
# What it does, in order:
#   1. Verifies Node.js >= 20 is present (the daemon is a Node process).
#   2. Installs the `qa` CLI globally from npm (browser-qa-subagent).
#   3. Registers `qa daemon` to auto-start on login (LaunchAgent on macOS,
#      systemd --user on Linux) and starts it now — so the extension's
#      connection dot goes green with no terminal.
#
# Re-running is safe (idempotent). Everything is per-user; no sudo required.

set -eu

PKG_NAME='browser-qa-subagent'

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
# --use-system-ca: on machines behind TLS-intercepting AV, the system CA store is
# what lets npm/OAuth work. Harmless elsewhere.
export NODE_OPTIONS='--use-system-ca'
if ! npm install -g "$PKG_NAME"; then
  warn 'npm install failed.'
  echo '  If this is a permissions error (EACCES), see:'
  echo '  https://docs.npmjs.com/resolving-eacces-permissions-errors'
  exit 1
fi
ok 'qa CLI installed'

step 'Registering the daemon to auto-start on login…'
if ! qa daemon --install-service; then
  warn 'Could not register the auto-start service.'
  echo '  You can still start the daemon manually any time with:  qa daemon'
  exit 1
fi

echo ''
ok 'Done. The QA Subagent desktop app is running and will start on every login.'
echo '  Go back to the browser extension — the connection dot should turn green shortly.'
echo '  To remove it later:  qa daemon --uninstall-service'
