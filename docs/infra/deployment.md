# Infrastructure: Deployment

> Scope: Build pipeline, output packaging, port allocation, auto-start service registration, and one-line install scripts.
> Rendering context: N/A
> Project tier: 3
> Last updated: 2026-07-18

## Overview

The project builds to a Node.js CLI binary and an MCP stdio server (both in dist/), plus a second bundle (extension/lite-engine.js) that gives the Chrome extension a daemon-free "Lite mode" execution path. The rest of the Chrome extension is plain MV3 JavaScript (no compile step) under extension/, packaged to dist/extension.zip for Chrome Web Store distribution via `npm run pack:extension`. The fixture app runs via tsx (no compile) from fixture/server.ts. Deployment also covers registering `qa daemon` as a per-user OS auto-start service (Windows Scheduled Task / macOS LaunchAgent / Linux systemd --user) and the two one-line install scripts (install/install.ps1, install/install.sh) that a non-technical user runs to get both the CLI and that auto-start registration in one shot.

AGENT OWNER: tsup.config.ts, tsup.lite.config.ts, scripts/pack-extension.ts, package.json, src/service/install-service.ts, install/install.ps1, install/install.sh

## Build Pipeline

`npm run build` runs two separate tsup builds back to back (`tsup && tsup --config tsup.lite.config.ts`):

1. **Node build** (tsup.config.ts) — esbuild-compiles the daemon/CLI:
   - src/cli.ts → dist/cli.js (with `#!/usr/bin/env node` banner)
   - src/mcp-server.ts → dist/mcp-server.js
   - ESM output (`type: "module"` in package.json), `platform: 'node'`, `target: 'node20'`, sourcemaps on, `clean: true` (dist/ wiped before each run). Requires Node.js >=20.
2. **Lite build** (tsup.lite.config.ts) — bundles the daemon-free engine the extension service worker imports:
   - src/extension/lite-engine.ts → extension/lite-engine.js (single self-contained ESM file; entry name `lite-engine`, `outDir: 'extension'`)
   - `platform: 'browser'`, `target: 'chrome120'`, `splitting: false`, `sourcemap: false`, **`clean: false`** (deliberately — never wipes the hand-written extension/*.js, manifest.json, panel.* files that live in the same directory). `noExternal: [/.*/]` bundles all deps inline (a service worker can't resolve bare `import from "buffer"`), with a `Buffer` polyfill injected via `src/extension/buffer-shim.ts` and `process.env.NODE_ENV` defined so no Node `process` global is needed at runtime.

`npm run build:lite` runs just the second build in isolation (fast iteration on the extension bundle without re-running the Node build).

`npm run typecheck` — runs `tsc --noEmit` over src/, fixture/, and test/. Does not emit; type errors must be clean before publishing. This is the CI gate.

`npm run pack:extension` — runs scripts/pack-extension.ts, which zips extension/* (contents, not the parent folder — manifest.json ends up at the zip root, as the Chrome Web Store expects) into dist/extension.zip, then prints a submission-readiness checklist (128px icon present + wired into manifest, description ≤132 chars, permission justifications reminder, screenshot/promo-tile reminders). Shells out to PowerShell's `Compress-Archive`/`System.IO.Compression.ZipFile` — **Windows-only today**; the script's own header flags this as a cross-platform TODO (a `zip` dep or a platform-detected `zip -r` fallback would be needed for macOS/Linux CI).

`npm run share` — `npm run build && npm run pack:extension`; the one-shot "produce everything distributable" command.

`npm run gen:icons` — runs scripts/gen-icons.ts to regenerate extension/icons/ from source assets. Run when the extension icon design changes.

`npm run test:e2e` — runs test/e2e.run-fixture.ts against the fixture app (both bug modes), using the built dist/ output.

`prepublishOnly` — automatically runs `npm run build` before `npm publish` (does NOT run pack:extension; the extension zip is a separate, manual submission artifact, not part of the npm package).

## Binary Distribution

The package.json `"bin"` field maps `qa` → `dist/cli.js`. After `npm install -g browser-qa-subagent`, the `qa` command is available on PATH. When used as an MCP tool, the coding agent config registers command `qa` with args `["mcp"]` to start the stdio server. Package name on npm: `browser-qa-subagent`; current version 0.1.0. No git tags / GitHub Releases exist yet (relevant to the install-script trust model below — there is no tagged script to pin to instead of `main`).

## Port Allocation

All daemon ports are fixed and distinct from the spike ports so a still-running spike Chrome never collides with the daemon (cross-checked against CLAUDE.md's "Port allocation" section and src/config.ts's `DEFAULTS`):

| Service | Port | Override env var |
|---|---|---|
| Daemon CDP | 9322 | QA_CDP_PORT |
| Nano runner HTTP | 9400 | QA_RUNNER_PORT |
| Fixture HTTP | 9401 | QA_FIXTURE_PORT |
| Extension bridge WS | 9410 | QA_BRIDGE_PORT (or `qa daemon --bridge-port <n>`) |
| Local dashboard HTTP | 9420 | QA_DASHBOARD_PORT (or `qa dashboard --port <n>`) |
| Spike B CDP | 9223 | (spike-only, never override) |
| Spike A CDP | 9224 | (spike-only, never override) |
| Spike HTTP | 9333/9334 | (spike-only, never override) |

The dashboard port (`qa dashboard`, src/cli.ts) is a newer addition — it is read directly from `QA_DASHBOARD_PORT` in the CLI rather than being part of `QaConfig`'s env-parsing table in src/config.ts, but the effective default (9420) and override behavior are the same shape as the other ports.

AGENT NOTE: If any daemon port is already in use (another process, a stale Chrome), Chrome/the bridge/the dashboard will fail to bind. Check with `netstat -ano | findstr :<port>` (Windows) or `lsof -i :<port>` (macOS/Linux) and kill the occupying process, or override with the QA_* env vars / CLI flags above.

## Chrome Profile Paths

Daemon profile: `%LOCALAPPDATA%\qa-subagent-chrome-profile` (falls back to `$HOME` when LOCALAPPDATA is unset, e.g. macOS/Linux) — holds the Nano model (~2 GB) once downloaded. Must be on a volume with 22 GB+ free; `nano --check` reporting `unavailable` is usually this storage gate, not a real capability failure. Override with `QA_CHROME_PROFILE`.

Spike A profile: `%LOCALAPPDATA%\qa-spike-chrome-profile` — separate from the daemon profile; used by spike-a-web.js (persistent, headed).

Extension-driver spike profile: `spikes/.chrome-profile/` — inside the repo, git-ignored.

AGENT AVOID: Never point two Chrome instances at the same profile directory simultaneously — Chrome locks its profile and the second instance will crash or refuse to start.

## Auto-Start Service Registration (`qa daemon --install-service`)

`src/service/install-service.ts` registers `qa daemon` to auto-start on login for the current user, so the daemon comes up with no terminal and the extension side panel's connection dot goes green on its own. `qa daemon --install-service` registers and starts it immediately (idempotent — safe to re-run, e.g. on upgrade); `qa daemon --uninstall-service` removes it. Both are one-shot: they print a result message and exit rather than running the daemon inline (see docs/api/route-handlers.md for the CLI contract). Everything is **per-user — no admin/root elevation required** on any platform.

Every platform re-invokes the exact same `node` executable and `cli.js` path that ran the install command (`resolveSelf()`, via `process.execPath` / `process.argv[1]`, realpath-resolved) — so a global npm install, an nvm-managed node, or a packaged binary all resolve correctly, and the AVG-TLS workaround `NODE_OPTIONS=--use-system-ca` is baked into the registered service's environment (`serviceEnv()`) so the daemon's own CLI-planner child processes don't hit OAuth/TLS exit 41.

Per-platform mechanism:

| Platform | Mechanism | Identifier / path | Notes |
|---|---|---|---|
| Windows | Scheduled Task via `schtasks` | Task name `"QA Subagent Daemon"` | `ONLOGON` trigger, **`/RU <username>`** (required — a bare `ONLOGON` trigger needs a machine-level logon-trigger right a non-elevated shell lacks, otherwise "Access is denied"), `/F` to overwrite on re-install. Env vars are injected via a `cmd /c set "K=V"&& ...` prefix chained ahead of the real `node "<cli>" daemon --bridge-port <n>` command (schtasks has no native env-var flag); keys/values containing `"` or a newline are rejected outright rather than mis-escaped. After registering, the task is started immediately via `schtasks /Run` (non-fatal if that fails). Uninstall: `schtasks /End` then `/Delete /F`. |
| macOS | LaunchAgent plist | `~/Library/LaunchAgents/com.qa-subagent.daemon.plist` | `RunAtLoad` + `KeepAlive` both true. Installed via `launchctl bootstrap gui/<uid> <plist>` (preceded by a best-effort `bootout` so re-install is idempotent) and enabled via `launchctl enable`. Uninstall: `launchctl bootout` then delete the plist file. |
| Linux | systemd --user unit | `$XDG_CONFIG_HOME/systemd/user/qa-subagent-daemon.service` (falls back to `~/.config/...`) | `ExecStart=<node> <cli> daemon --bridge-port <n>`, `Restart=on-failure` (3s backoff). Installed via `systemctl --user daemon-reload` then `enable --now`; needs a user systemd instance (most desktop Linux) — fails with a clear message in containers/minimal hosts (`loginctl enable-linger $USER` may be needed for the unit to survive logout). Uninstall: `systemctl --user disable --now` then delete the unit file. Env values containing a newline are rejected (would inject a second unit-file directive, e.g. a spoofed `ExecStart=`). |
| other | unsupported | — | `installService()`/`uninstallService()` return `ok: false` with a message to run `qa daemon` manually. |

All external command spawns (`schtasks`, `launchctl`, `systemctl`) route through a single `run()` indirection that tests stub via `__setRunner` to assert exact args with zero OS persistence — per CLAUDE.md, never smoke-test `--install-service` by actually registering a real task/agent/unit, since that persists beyond the session.

## One-Line Install Scripts (install/install.ps1, install/install.sh)

Two scripts give a non-technical user a single copy-pasted command that ends with the daemon auto-starting — surfaced in the extension side panel's "Connect the desktop app" card (shown while the daemon dot is red), per-OS, from `extension/panel.js`'s `INSTALL_CMDS`:

- Windows: `irm https://raw.githubusercontent.com/uvesarshad/spike/main/install/install.ps1 | iex`
- macOS / Linux: `curl -fsSL https://raw.githubusercontent.com/uvesarshad/spike/main/install/install.sh | sh`

`INSTALL_BASE` (`extension/panel.js`) is `https://raw.githubusercontent.com/uvesarshad/spike/main/install` — **nothing is hosted server-side**: GitHub Raw serves the two static install scripts off the `main` branch ($0, no backend), npm hosts the `browser-qa-subagent` package itself, and the daemon that ends up running is on the user's own machine (`localhost:9410`). The panel also offers a "without a remote script (npm)" toggle (`INSTALL_CMDS_NPM`) that skips fetching install.ps1/install.sh entirely and runs the equivalent two commands directly: `npm i -g browser-qa-subagent` then `qa daemon --install-service`.

Both scripts do the same three things, in order, and are safe to re-run (idempotent — upgrades the package, re-registers the service):

1. Verify Node.js >=20 is on PATH (exit 1 with an install-Node hint if missing or too old).
2. `npm install -g browser-qa-subagent`, with `NODE_OPTIONS=--use-system-ca` exported first (the same AVG-TLS workaround baked into the registered service's env, needed here so the `npm install` itself doesn't hit TLS interception).
3. Run `qa daemon --install-service` (Scheduled Task on Windows / LaunchAgent on macOS / systemd --user on Linux, per the table above) and report success/failure.

Trust model (documented in both scripts' headers and in docs/plan/26-07-14-audit-perf-security.md A18): fetching over `irm | iex` / `curl | sh` from GitHub Raw's `main` branch has no pinned commit/tag and no signature/checksum on the script content — a compromised push to `main` would run unverified on the next click of "Connect the desktop app." The blast radius is bounded: the script's only side effects are `npm install -g browser-qa-subagent` (covered by npm registry package integrity) and registering a per-user autostart entry — no other privilege escalation. There are no git tags/GitHub Releases yet to pin to instead of `main`; if tagged releases are introduced later, prefer fetching the install script from that tag. The npm-only fallback in the panel sidesteps this class of risk entirely by never fetching the remote script.

## MCP Tool Registration

Add to the coding agent's MCP config (e.g., Claude Code's .claude/settings.json or MCP config file):

name: "qa"
command: "qa" (or full path to dist/cli.js if not globally installed)
args: ["mcp"]
transport: "stdio"

The MCP server reads from stdin and writes to stdout. It does not open any HTTP port.

## Environment Configuration for Production

For CI or a shared dev environment, set env vars rather than relying on qa.config.json:
- QA_CDP_PORT, QA_RUNNER_PORT, QA_FIXTURE_PORT, QA_BRIDGE_PORT, QA_DASHBOARD_PORT: choose non-default ports if defaults conflict.
- QA_CHROME_PROFILE: explicit path on a high-capacity (22 GB+ free) volume.
- GEMINI_API_KEY or other BYOK keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, GLM_API_KEY/GLM_BASE_URL): injected by CI secrets.
- QA_NAVIGATOR_PROVIDER/QA_NAVIGATOR_MODE and QA_PLANNER_PROVIDER/QA_PLANNER_MODE: pin the navigator and brain roles independently of the SettingsStore (env beats SettingsStore) — see CLAUDE.md's navigator/brain gotcha for the reliable non-Nano recipe.
- QA_ALLOWED_HOSTS: add the staging/production host under test (the `--url`/task host is trusted automatically per-run; this is for extra hosts).
- QA_RECORD_CLIP: set to '0' (or leave unset) in headless CI (Page.startScreencast requires a display).

AGENT NOTE: QA_RECORD_CLIP must be false (or unset) in headless CI. CDP Page.startScreencast requires a visible Chrome window. Setting QA_VIA=cdp with a headless Chrome on a display-less server will likely fail at the screencast step.

## Update Triggers

- When tsup.config.ts or tsup.lite.config.ts changes (new entry points, output format, target).
- When port defaults change in src/config.ts or the dashboard's hardcoded default in src/cli.ts.
- When the Chrome profile path logic changes.
- When a new build script is added to scripts/ or package.json's `scripts` block changes.
- When install-service.ts's per-platform mechanism, service identifiers, or baked-in env change.
- When install/install.ps1 or install/install.sh change what they install/verify, or INSTALL_BASE moves off GitHub Raw.
- When scripts/pack-extension.ts's packaging or Web Store checklist logic changes.

## Related Docs

- docs/infra/environment.md — all env vars and their defaults
- docs/infra/testing.md — how to run tests (uses the build output)
- docs/modules/engine.md — Chrome launch and profile management
- docs/api/route-handlers.md — the `qa daemon --install-service`/`--uninstall-service` and `qa dashboard` CLI contract
- docs/modules/vibe-mode.md — the daemon, bridge, and extension panel that surfaces the install one-liners
