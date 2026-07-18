# Module: Vibe Mode

> Scope: VibeService daemon (src/vibe/), BridgeServer transport, side panel extension UI, and auto-fix loop.
> Rendering context: Server-side daemon + client-side Chrome extension
> Project tier: 3
> Last updated: 2026-07-18

## Overview

Vibe mode is the interactive daemon experience: `qa daemon` starts a persistent process that bridges the Chrome extension side panel to the QA engine. The user clicks "Run" in the panel; the daemon drives their existing Chrome tab (no separate profile); the side panel animates step progress in real time. When a run fails, vibe mode can synthesize a paste-ready fix prompt or hand it to a coding agent headlessly.

When no daemon is connected, the same side panel falls back to **Lite mode** — a daemon-less execution path where the extension itself drives the run. See "Lite Mode" below; everywhere else in this doc "vibe mode" implies the daemon IS connected (what the codebase calls "Pro mode" in sw.js's comments).

AGENT OWNER: src/vibe/, extension/, src/extension/

## VibeService (src/vibe/service.ts)

The vibe.run service started by `qa daemon`. Listens for bridge events from the extension (vibe.run, vibe.cancel, vibe.config.get, vibe.config.set). On a vibe.run event:

1. Calls qaRun() with the injected bridge and the panel-supplied tabId and clientId.
2. Forwards onStep events back to the panel as vibe.step bridge events (the panel animates the ghost cursor and step list).
3. Synthesizes a Report on completion and sends vibe.result back to the panel.
4. Calls fixPrompt.build(report) to prepare the paste-ready fix prompt and stores it by runId.

AGENT NOTE: The VibeService reuses the caller's BridgeServer — it never creates a second one. The daemon's single bridge serves all connected Chrome instances simultaneously. Each run is bound to its clientId to prevent cross-Chrome interference.

AGENT NOTE (auth): every mutating reverse-RPC handler (`vibe.run`, `vibe.fix`, `vibe.config.set`, `vibe.key.set`, `vibe.key.clear`) calls `bridge.isAuthenticated(ctx.clientId)` first and throws if the calling client hasn't passed the bridge's pairing-token gate (see browser-port.md's Bridge section) — a change from earlier versions where any `onRequest` call was implicitly trusted. `vibe.run`'s `allowHost` param (the panel's per-run consent toggle) is additionally validated by `isPlainHostname()` — a bare hostname with an optional `:port`, no scheme/path/credentials — before it's folded into `allowedHosts`, so an authenticated caller still can't inject an arbitrary string into the Tier-4 host guard.

## Fix Prompt (src/vibe/fix-prompt.ts)

buildFixPrompt(report) generates a paste-ready plain-English fix prompt from a failing Report. It includes the task, the failing step description, the console error (if any), and the evidence paths. The `qa fix <runId>` CLI command loads the stored prompt and prints it.

AGENT SEE: docs/api/route-handlers.md — the `qa fix` and `qa daemon` CLI commands

## Auto-Fix Loop (src/vibe/auto-fix.ts)

When cfg.debugMode is 'auto', the auto-fix loop:

1. Builds a fix prompt from the failing report.
2. Spawns the configured coding agent CLI (cfg.fixAgentBin or auto-detected claude/codex on PATH) with the prompt.
3. Waits for the agent to complete.
4. Re-runs qaRun() on the same task and URL.
5. Loops until the verdict is 'pass' or a max-attempts guard fires.

The coding agent binary and args are fully configurable (QA_FIX_AGENT_BIN, QA_FIX_AGENT_ARGS) and are never hardcoded. '{prompt}' in the args array is substituted with the actual fix prompt.

AGENT AVOID: Do not hardcode 'claude' or 'codex' as the fix agent binary. The config key is cfg.fixAgentBin; 'auto' means detect on PATH at runtime.

## Lite Mode (src/extension/, bundled as extension/lite-engine.js)

Lite mode is the daemon-less fallback: when the side panel's bridge connection to `qa daemon` isn't up (`daemonConnected()` in sw.js is false), the panel's run/config/key messages are served LOCALLY by running a bundled copy of the engine inside the extension's own service worker — no WebSocket bridge, no BridgeServer, no separate Node process. The user gets BYOK/Nano QA testing before ever touching a terminal; sw.js's own comments call this "Pro mode" (daemon connected) vs "Lite mode" (not).

- `src/extension/lite-engine.ts` — the daemon-free engine entry, tsup-bundled (browser target) into `extension/lite-engine.js`, which `sw.js` statically imports (`import { runLite, buildLiteConfig, DEFAULT_SETTINGS } from './lite-engine.js'`, requiring the manifest to declare the SW as a module). It composes ONLY portable pieces — the driver loop, `ModelRouter`, the BYOK + Nano adapters, `LiteExtensionBrowser`, `BrowserArtifactStore` — and MUST NOT import `engine.ts`/`config.ts`/`settings.ts`/`vault.ts`/the CLI or Ollama adapters, since any of those would drag the Node module graph into the browser bundle (enforced by a grep gate on the emitted bundle). `runLite(opts)` builds a BYOK-only adapter ladder (`buildLiteLadder`) pinning both the navigator (plan-step) and brain (plan-goals) roles, adds Nano as the rung-0 visual adapter when the SW reports it available, and runs `runDriverLoop()` exactly as the daemon path does. `buildLiteConfig()` produces the same `vibe.config.get`-shaped payload the daemon returns (plus a `mode:'lite'` marker) so `panel.js`'s `renderSettings` needs no lite-specific branching.
- `src/extension/lite-extension-browser.ts` (`LiteExtensionBrowser`) — the lite-mode `BrowserPort`: drives the page via `chrome.debugger` DIRECTLY (no bridge), with all `chrome.*` access injected as `LiteBrowserDeps` by the SW so the module stays chrome-free and typechecks under the Node tsconfig. A transport-pure clone of `src/ports/extension-browser.ts` — click/type/verifyTyped and the capture/executor helpers are reused byte-for-byte. `openTab`/`switchTab`/`closeTab` throw "not supported" (single-tab attach only), matching ExtensionBrowser's tab-primitive gap.
- `src/extension/browser-artifacts.ts` (`BrowserArtifactStore`) — in-memory `ArtifactStore` replacement (no filesystem in a service worker): screenshots as base64 strings, the latest `Report`, an audit array. `exportBundle()` hands the panel a `{runId, reportJson, screenshots, audit}` bundle for a "download report.json + screenshots" affordance. Screenshots are session-only, never persisted to `chrome.storage` (a full-page PNG is ~2.7 MB, far past the 10 MB quota).
- `src/extension/lite-nano.ts` (`LiteNano`) — Nano Prompt API access for lite mode, same interface as the daemon's NanoPort implementations.
- `src/vibe/settings-data.ts` — pure settings DATA + helpers (NO Node imports), the single source of truth both `src/vibe/settings.ts` (daemon, fs-backed `SettingsStore`) and lite mode re-export from. Defines `LITE_PLANNER_PROVIDERS` (`gemini`, `claude`, `gpt`, `openrouter`, `glm` — BYOK API only, no CLI/Ollama rungs in a browser) and `LITE_NAVIGATOR_PROVIDERS` (`nano`, `gemini`, `claude`, `gpt`, `openrouter` — `glm` excluded, it's text-only and the navigator must see the page every step).

Keys and settings live in `chrome.storage.local` (`qaKeys`, `qaSettings`), not the Vault or `SettingsStore` — those are Node-only. What lite mode CANNOT do (needs the daemon): CLI planners/navigators (`claude`/`codex`/`gemini` CLI, or Ollama — nothing that spawns a process), the auto-fix loop (edits files on disk), and replay-clip download (`extension/panel.js` shows `'replay clips need the desktop app (lite mode is test-only).'` when the daemon isn't connected). `buildLiteConfig()`'s per-provider `liteUsable` flag is `false` for `nano` and `ollama` in the GENERIC provider list (nano needs the daemon to plan, ollama needs a local server) — this is separate from `LITE_NAVIGATOR_PROVIDERS`, which still lists `nano` as a valid NAVIGATOR pick via the dedicated rung-0 `nanoDeps` path in `runLite()`.

AGENT AVOID: Do not add a `node:*` import (or anything that transitively pulls one in) to `src/extension/lite-engine.ts`, `lite-extension-browser.ts`, `lite-nano.ts`, or `browser-artifacts.ts` — it will bundle into the shipped extension and either fail at build time or silently bloat/break the SW.

## SettingsStore (src/vibe/settings.ts)

Persists the user's non-secret picks to %LOCALAPPDATA%\qa-subagent\settings.json (Windows) or $HOME/qa-subagent/settings.json (other platforms). Fields: planner (Brain PlannerSelection), navigator (Navigator PlannerSelection), debugMode ('prompt' | 'auto'), debugAgent ('auto' | 'claude' | 'codex' | 'gemini'). API keys never land here — those go in the Vault.

loadConfig() folds SettingsStore below env vars, so QA_* env vars always win for power users and CI.

Runtime-generated data is not SettingsStore state. Reports, screenshots, audit logs, and clips belong under ArtifactStore; generated replay scripts belong under generated-tests/; the last failed report/fix prompt is daemon memory derived from a Report.

AGENT SEE: docs/state/server-state.md — full SettingsStore persistence detail

## Chrome Extension (extension/)

The MV3 Chrome extension provides both the vibe-mode UI layer (daemon connected) and the Lite-mode execution engine (daemon absent). Its components:

sw.js — Service worker. Connects to BridgeServer on startup, relays CDP operations via chrome.debugger (cdp-shim), forwards console/network events to the daemon, handles vibe.run / vibe.cancel messages. `daemonConnected()` (socket open) gates whether a panel run/config/key message is forwarded to the daemon (Pro mode) or served by the in-SW `runLite()`/`buildLiteConfig()` calls imported from lite-engine.js (Lite mode) — see "Lite Mode" above. Also fans in-SW `chrome.debugger` CDP events out to lite mode's `CdpTransport.subscribe` taps.

lite-engine.js — tsup-bundled build artifact of `src/extension/lite-engine.ts` (+ its lite-mode dependency graph). Statically imported by sw.js; not hand-edited — change the `.ts` source and rebuild.

panel.html / panel.js / panel.css — Side panel UI. Displays the run history list, current step progress, fix-prompt text area, Navigator and Brain model selector cards (each with its own provider/mode/model/key row), read-only and spend-cap safety toggles, a light/dark theme toggle, the "Connect the desktop app" onboarding block (see below), and clip download affordance. Communicates with sw.js via a long-lived `chrome.runtime.connect({name:'vibe-panel'})` port, polling `{kind:'bridge-status'}` every 3s.

overlay.js — Ghost-cursor overlay injected into the page under test. Animates the cursor glide, ripple effects, and step captions in real time as the daemon (or, in Lite mode, the in-SW engine) drives the tab. Receives messages from sw.js.

nano-offscreen.html / nano-offscreen.js — Offscreen document for Gemini Nano Prompt API access. Used when there is no daemon-owned runner page (vibe mode's ExtensionNano and Lite mode's LiteNano both go through it) to invoke window.ai in a secure context.

icons/ — Extension icons at 16, 32, 48, and 128 px.

manifest.json — MV3 manifest. Key permissions: debugger (for chrome.debugger CDP proxy), scripting (for overlay injection), activeTab, sidePanel, storage (chrome.storage.local for Lite-mode keys/settings). The service worker is declared as an ES module (`"type": "module"`) so sw.js's static `import` of lite-engine.js works.

AGENT NOTE: --load-extension is dead in branded Chrome 137+. Dev-loading the extension requires CDP Extensions.loadUnpacked (via src/chrome/extensions.ts) or manual chrome://extensions. The daemon handles this automatically; manual installs need the user to load the unpacked extension themselves.

## Connect the Desktop App (onboarding)

The panel's Settings → Debugging section shows a "Connect the desktop app" block whenever the daemon dot is red (`!bridgeHealthy()` — no daemon connected, or connected but failing the protocol-version handshake; see browser-port.md's Bridge section). Its copy switches to "Update the desktop app" when the daemon IS connected but reports an incompatible `protocolVersion` (`CONNECT_APP_COPY.update` in panel.js) — "install" would be misleading in that state.

The block hands the user a per-OS one-liner (`connectOs` — win/mac/linux) built from `extension/panel.js`'s `INSTALL_BASE = 'https://raw.githubusercontent.com/uvesarshad/browser-qa-subagent/main/install'`:

- Default (remote-script) form: `irm <INSTALL_BASE>/install.ps1 | iex` (Windows) or `curl -fsSL <INSTALL_BASE>/install.sh | sh` (macOS/Linux) — served straight from GitHub Raw, `$0`, static, no backend.
- A "without a remote script (npm)" toggle (`connectNpmToggle`) swaps to the pure npm form: `npm i -g browser-qa-subagent && qa daemon --install-service` (`; ` separator on Windows), for users who'd rather not pipe a remote script.

`install/install.ps1` and `install/install.sh` (both re-run-safe/idempotent) do the same three things per OS: verify Node 20+, `npm install -g browser-qa-subagent`, then call `qa daemon --install-service` (src/service/install-service.ts) to register the daemon as a per-user autostart entry and start it immediately — the panel's 3s bridge-status poll then flips the dot green with no further terminal interaction. Both scripts carry a documented trust-model comment: fetched unpinned from `main` via `curl|sh`/`irm|iex` with no signature/checksum check on the script itself, but the only side effect beyond registering the autostart unit is `npm install -g browser-qa-subagent`, which npm registry integrity already covers; the npm-only fallback above skips fetching the script entirely for users who want to avoid that trust step.

Nothing here is hosted server-side: npm hosts the package, GitHub Raw serves the 2 install scripts, and the daemon runs on the user's OWN machine (localhost) — see the CLAUDE.md root doc for the full flow description.

AGENT SEE: docs/modules/browser-port.md's Bridge section for the pairing-token/protocol-version mechanics this block reacts to.

## Daemon Startup (`qa daemon`)

cli.ts starts BridgeServer on cfg.bridgePort (default 9410), instantiates VibeService, and keeps the process alive. The daemon also runs the vibe.run HTTP API (if any) and logs "bridge ready" once the server is up. The daemon itself does not open Chrome — Chrome is opened by the first vibe.run request or by the user's existing Chrome connecting via the extension.

## Update Triggers

- When VibeService gains new bridge message types (vibe.*).
- When the fix prompt format changes (buildFixPrompt).
- When the auto-fix loop's max-attempts or config keys change.
- When the extension manifest.json permissions change.
- When the side panel UI adds or removes features.
- When SettingsStore gains new fields.
- When lite-engine.ts's adapter ladder or the daemon/Lite feature gap changes (LITE_PLANNER_PROVIDERS, LITE_NAVIGATOR_PROVIDERS, liteUsable).
- When the install scripts' behavior, INSTALL_BASE, or the protocol-version compatibility gate changes.

## Related Docs

- docs/modules/browser-port.md — ExtensionBrowser and BridgeServer detail (bridge pairing token, Origin check, protocol-version handshake)
- docs/modules/engine.md — how the injected bridge is threaded into qaRun
- docs/state/server-state.md — SettingsStore and Vault persistence
- docs/infra/environment.md — QA_DEBUG_MODE, QA_FIX_AGENT_BIN, QA_BRIDGE_PORT
