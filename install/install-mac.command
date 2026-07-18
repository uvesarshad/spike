#!/bin/sh
# QA Subagent — downloadable macOS installer.
#
# HOW TO USE: double-click this file in Finder. It opens Terminal and runs the
# steps below. (If macOS blocks it with "unidentified developer", right-click →
# Open the first time, or run `xattr -d com.apple.quarantine install-mac.command`.)
#
# This is SELF-CONTAINED — it does not fetch anything but the npm package, so it
# works even before the GitHub raw one-liner is live. It:
#   1. Verifies Node.js >= 20 (the daemon is a Node process).
#   2. Installs the `qa` CLI globally from npm (browser-qa-subagent).
#   3. Registers `qa daemon` to auto-start on login (LaunchAgent) and starts it
#      now — so the browser extension's connection dot goes green, no terminal.
#
# Re-running is safe (idempotent). Everything is per-user; no sudo required.

set -eu

PKG_NAME='browser-qa-subagent'

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m[OK] %s\033[0m\n' "$1"; }
warn() { printf '\033[33m[!] %s\033[0m\n' "$1"; }

# Keep the Terminal window open on exit so a double-click user can read the
# result instead of the window vanishing.
pause_and_exit() {
  code="$1"
  echo ''
  printf 'Press Return to close this window… '
  read _ || true
  exit "$code"
}

# Double-clicked .command runs with cwd = home; that's fine (nothing here is
# path-relative), but cd to the script dir for predictability.
cd "$(dirname "$0")" 2>/dev/null || true

step 'Checking Node.js…'
if ! command -v node >/dev/null 2>&1; then
  warn 'Node.js was not found on your PATH.'
  echo '  Install Node 20+ from https://nodejs.org (or `brew install node`), then re-run this.'
  pause_and_exit 1
fi
NODE_VERSION="$(node --version | sed 's/^v//')"
NODE_MAJOR="$(echo "$NODE_VERSION" | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  warn "Node $NODE_VERSION found, but the daemon needs Node 20+."
  echo '  Upgrade from https://nodejs.org and re-run this.'
  pause_and_exit 1
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
  pause_and_exit 1
fi
ok 'qa CLI installed'

step 'Registering the daemon to auto-start on login…'
if ! qa daemon --install-service; then
  warn 'Could not register the auto-start service.'
  echo '  You can still start the daemon manually any time with:  qa daemon'
  pause_and_exit 1
fi

echo ''
ok 'Done. The QA Subagent desktop app is running and will start on every login.'
echo '  Go back to the browser extension — the connection dot should turn green shortly.'
echo '  To remove it later:  qa daemon --uninstall-service'
pause_and_exit 0
