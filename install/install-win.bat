@echo off
setlocal
REM Spike installer - Windows.
REM
REM HOW TO USE: double-click this file. (SmartScreen may warn on an unsigned
REM script the first time: "More info" > "Run anyway".) It:
REM   1. Verifies Node.js >= 20 (the daemon is a Node process).
REM   2. Installs the qa CLI globally from npm (browser-qa-subagent).
REM   3. Registers "qa daemon" to auto-start on login (Scheduled Task) and starts
REM      it now - so the browser extension's connection dot goes green, no terminal.
REM
REM Re-running is safe (idempotent). Everything is per-user; no admin required.
REM npm and qa are .cmd shims, so each is invoked with CALL to return control here.

title Spike installer

echo ==^> Checking Node.js...
where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js was not found on your PATH.
  echo     Install Node 20+ from https://nodejs.org ^(or: winget install OpenJS.NodeJS.LTS^), then re-run this.
  goto :fail
)
for /f "tokens=* usebackq" %%v in (`node --version`) do set "NODE_VER=%%v"
set "NODE_VER=%NODE_VER:v=%"
for /f "tokens=1 delims=." %%a in ("%NODE_VER%") do set "NODE_MAJOR=%%a"
if %NODE_MAJOR% LSS 20 (
  echo [!] Node %NODE_VER% found, but the daemon needs Node 20+.
  echo     Upgrade from https://nodejs.org and re-run this.
  goto :fail
)
echo [OK] Node %NODE_VER%

echo ==^> Installing the qa CLI globally ^(npm i -g browser-qa-subagent^)...
REM --use-system-ca: on machines behind TLS-intercepting AV, the system CA store
REM is what lets npm work. Harmless elsewhere.
set "NODE_OPTIONS=--use-system-ca"
call npm install -g browser-qa-subagent
if errorlevel 1 (
  echo [!] npm install failed.
  echo     If this is a permissions error, see https://docs.npmjs.com/resolving-eacces-permissions-errors
  goto :fail
)
echo [OK] qa CLI installed

echo ==^> Registering the daemon to auto-start on login...
call qa daemon --install-service
if errorlevel 1 (
  echo [!] Could not register the auto-start service.
  echo     You can still start the daemon manually any time with:  qa daemon
  goto :fail
)

echo.
echo [OK] Done. Spike is running and will start on every login.
echo     Go back to the browser extension - the connection dot should turn green shortly.
echo     To remove it later:  qa daemon --uninstall-service
echo.
pause
endlocal
exit /b 0

:fail
echo.
pause
endlocal
exit /b 1
