# Spike installer — one-line (Windows / PowerShell)
#
# Usage (from the extension's "Connect Spike Core" button, or by hand):
#     irm https://raw.githubusercontent.com/uvesarshad/spike/main/install/install.ps1 | iex
#
# What it does, in order:
#   1. Verifies Node.js >= 20 is present (the daemon is a Node process).
#   2. Installs the `spike` CLI globally from npm (spike-agent).
#   3. Registers `spike daemon` to auto-start on login (Scheduled Task) and starts
#      it now — so the extension's connection dot goes green with no terminal.
#
# Re-running is safe (idempotent): it upgrades the package and re-registers the
# task. Everything is per-user; no admin elevation required.
#
# Trust model (see docs/plan/26-07-14-audit-perf-security.md A18):
#   This script is fetched over `irm ... | iex` straight from GitHub Raw's
#   `main` branch (see INSTALL_BASE in the extension panel) — there is no
#   pinned commit/tag and no signature/checksum check on the script content
#   itself. A compromised push to `main` would run unverified on the next
#   click of "Connect Spike Core." The blast radius is bounded, though:
#   this script's only side effect beyond writing a scheduled task is
#   `npm install -g spike-agent`, and npm registry integrity
#   (package signing/checksums) already covers that actual payload — this
#   script is just a thin, auditable bootstrapper around it. There is also a
#   non-remote-script fallback (the panel's "without a remote script (npm)"
#   toggle) that skips fetching this file entirely.
#   package.json currently has a version field (0.0.1) but this repo has no
#   git tags / GitHub Releases yet, so there is no tagged install script to
#   pin to instead of `main` today. If tagged releases are introduced later,
#   prefer fetching install.ps1 from that tag instead of `main` — until then,
#   this is a documented tradeoff, not a silent gap.

$ErrorActionPreference = 'Stop'
$PkgName = 'spike-agent'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[!] $msg" -ForegroundColor Yellow }

Write-Step "Checking Node.js…"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Warn "Node.js was not found on your PATH."
  Write-Host "  Install Node 20+ from https://nodejs.org (or 'winget install OpenJS.NodeJS.LTS'), then re-run this."
  exit 1
}
$nodeVersion = (& node --version).TrimStart('v')
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 20) {
  Write-Warn "Node $nodeVersion found, but the daemon needs Node 20+."
  Write-Host "  Upgrade from https://nodejs.org and re-run this."
  exit 1
}
Write-Ok "Node $nodeVersion"

Write-Step "Installing the qa CLI globally (npm i -g $PkgName)…"
# --use-system-ca: on machines behind TLS-intercepting AV (e.g. AVG), the system
# CA store is what lets npm/OAuth work. Harmless elsewhere.
$env:NODE_OPTIONS = '--use-system-ca'
& npm install -g $PkgName
if ($LASTEXITCODE -ne 0) {
  Write-Warn "npm install failed (exit $LASTEXITCODE)."
  Write-Host "  If this is a permissions error, see https://docs.npmjs.com/resolving-eacces-permissions-errors"
  exit 1
}
Write-Ok "qa CLI installed"

Write-Step "Registering the daemon to auto-start on login…"
& spike daemon --install-service
if ($LASTEXITCODE -ne 0) {
  Write-Warn "Could not register the auto-start service."
  Write-Host "  You can still start the daemon manually any time with:  spike daemon"
  exit 1
}

Write-Host ""
Write-Ok "Done. Spike is running and will start on every login."
Write-Host "  Go back to the browser extension — the connection dot should turn green shortly."
Write-Host "  To remove it later:  spike daemon --uninstall-service"
