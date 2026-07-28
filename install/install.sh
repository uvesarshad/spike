#!/bin/sh
# Spike installer — one-line (macOS / Linux)
#
# Usage (from the extension's "Connect Spike Core" button, or by hand):
#     curl -fsSL https://raw.githubusercontent.com/uvesarshad/spike/main/install/install.sh | sh
#
# What it does, in order:
#   1. Verifies Node.js >= 20 is present (the daemon is a Node process).
#   2. Installs the `spike` CLI globally from npm (spike-agent).
#   3. Registers `spike daemon` to auto-start on login (LaunchAgent on macOS,
#      systemd --user on Linux) and starts it now — so the extension's
#      connection dot goes green with no terminal.
#
# Re-running is safe (idempotent). Everything is per-user; no sudo required.
#
# Trust model (see docs/plan/26-07-14-audit-perf-security.md A18):
#   This script is fetched over `curl ... | sh` straight from GitHub Raw's
#   `main` branch (see INSTALL_BASE in the extension panel) — there is no
#   pinned commit/tag and no signature/checksum check on the script content
#   itself. A compromised push to `main` would run unverified on the next
#   click of "Connect Spike Core." The blast radius is bounded, though:
#   this script's only side effect beyond registering an autostart unit is
#   `npm install -g spike-agent`, and npm registry integrity
#   (package signing/checksums) already covers that actual payload — this
#   script is just a thin, auditable bootstrapper around it. There is also a
#   non-remote-script fallback (the panel's "without a remote script (npm)"
#   toggle) that skips fetching this file entirely.
#   package.json currently has a version field (0.0.1) but this repo has no
#   git tags / GitHub Releases yet, so there is no tagged install script to
#   pin to instead of `main` today. If tagged releases are introduced later,
#   prefer fetching install.sh from that tag instead of `main` — until then,
#   this is a documented tradeoff, not a silent gap.

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
if ! spike daemon --install-service; then
  warn 'Could not register the auto-start service.'
  echo '  You can still start the daemon manually any time with:  spike daemon'
  exit 1
fi

echo ''
ok 'Done. Spike is running and will start on every login.'
echo '  Go back to the browser extension — the connection dot should turn green shortly.'
echo '  To remove it later:  spike daemon --uninstall-service'
