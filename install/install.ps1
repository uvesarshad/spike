# QA Subagent — one-line desktop-app installer (Windows / PowerShell)
#
# Usage (from the extension's "Connect desktop app" button, or by hand):
#     irm https://<your-host>/install.ps1 | iex
#
# What it does, in order:
#   1. Verifies Node.js >= 20 is present (the daemon is a Node process).
#   2. Installs the `qa` CLI globally from npm (browser-qa-subagent).
#   3. Registers `qa daemon` to auto-start on login (Scheduled Task) and starts
#      it now — so the extension's connection dot goes green with no terminal.
#
# Re-running is safe (idempotent): it upgrades the package and re-registers the
# task. Everything is per-user; no admin elevation required.

$ErrorActionPreference = 'Stop'
$PkgName = 'browser-qa-subagent'

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
& qa daemon --install-service
if ($LASTEXITCODE -ne 0) {
  Write-Warn "Could not register the auto-start service."
  Write-Host "  You can still start the daemon manually any time with:  qa daemon"
  exit 1
}

Write-Host ""
Write-Ok "Done. The QA Subagent desktop app is running and will start on every login."
Write-Host "  Go back to the browser extension — the connection dot should turn green shortly."
Write-Host "  To remove it later:  qa daemon --uninstall-service"
