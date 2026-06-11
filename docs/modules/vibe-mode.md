# Module: Vibe Mode

> Scope: VibeService daemon (src/vibe/), BridgeServer transport, side panel extension UI, and auto-fix loop.
> Rendering context: Server-side daemon + client-side Chrome extension
> Project tier: 3
> Last updated: 2026-06-11

## Overview

Vibe mode is the interactive daemon experience: `qa daemon` starts a persistent process that bridges the Chrome extension side panel to the QA engine. The user clicks "Run" in the panel; the daemon drives their existing Chrome tab (no separate profile); the side panel animates step progress in real time. When a run fails, vibe mode can synthesize a paste-ready fix prompt or hand it to a coding agent headlessly.

AGENT OWNER: src/vibe/, extension/

## VibeService (src/vibe/service.ts)

The vibe.run service started by `qa daemon`. Listens for bridge events from the extension (vibe.run, vibe.cancel, vibe.config.get, vibe.config.set). On a vibe.run event:

1. Calls qaRun() with the injected bridge and the panel-supplied tabId and clientId.
2. Forwards onStep events back to the panel as vibe.step bridge events (the panel animates the ghost cursor and step list).
3. Synthesizes a Report on completion and sends vibe.result back to the panel.
4. Calls fixPrompt.build(report) to prepare the paste-ready fix prompt and stores it by runId.

AGENT NOTE: The VibeService reuses the caller's BridgeServer — it never creates a second one. The daemon's single bridge serves all connected Chrome instances simultaneously. Each run is bound to its clientId to prevent cross-Chrome interference.

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

## SettingsStore (src/vibe/settings.ts)

Persists the user's non-secret picks to %LOCALAPPDATA%\qa-subagent\settings.json (Windows) or $HOME/qa-subagent/settings.json (other platforms). Fields: planner (PlannerSelection), debugMode ('prompt' | 'auto'), debugAgent ('auto' | 'claude' | 'codex' | 'gemini'). API keys never land here — those go in the Vault.

loadConfig() folds SettingsStore below env vars, so QA_* env vars always win for power users and CI.

AGENT SEE: docs/state/server-state.md — full SettingsStore persistence detail

## Chrome Extension (extension/)

The MV3 Chrome extension provides the vibe-mode UI layer. Its components:

sw.js — Service worker. Connects to BridgeServer on startup, relays CDP operations via chrome.debugger (cdp-shim), forwards console/network events to the daemon, handles vibe.run / vibe.cancel messages.

panel.html / panel.js / panel.css — Side panel UI. Displays the run history list, current step progress, fix-prompt text area, and model selector. Communicates with sw.js via chrome.runtime.sendMessage.

overlay.js — Ghost-cursor overlay injected into the page under test. Animates the cursor glide, ripple effects, and step captions in real time as the daemon drives the tab. Receives messages from sw.js.

nano-offscreen.html / nano-offscreen.js — Offscreen document for Gemini Nano Prompt API access. Used in vibe mode (where there is no daemon-owned runner page) to invoke window.ai in a secure context.

icons/ — Extension icons at 16, 32, 48, and 128 px.

manifest.json — MV3 manifest. Key permissions: debugger (for chrome.debugger CDP proxy), scripting (for overlay injection), activeTab, sidePanel.

AGENT NOTE: --load-extension is dead in branded Chrome 137+. Dev-loading the extension requires CDP Extensions.loadUnpacked (via src/chrome/extensions.ts) or manual chrome://extensions. The daemon handles this automatically; manual installs need the user to load the unpacked extension themselves.

## Daemon Startup (`qa daemon`)

cli.ts starts BridgeServer on cfg.bridgePort (default 9410), instantiates VibeService, and keeps the process alive. The daemon also runs the vibe.run HTTP API (if any) and logs "bridge ready" once the server is up. The daemon itself does not open Chrome — Chrome is opened by the first vibe.run request or by the user's existing Chrome connecting via the extension.

## Update Triggers

- When VibeService gains new bridge message types (vibe.*).
- When the fix prompt format changes (buildFixPrompt).
- When the auto-fix loop's max-attempts or config keys change.
- When the extension manifest.json permissions change.
- When the side panel UI adds or removes features.
- When SettingsStore gains new fields.

## Related Docs

- docs/modules/browser-port.md — ExtensionBrowser and BridgeServer detail
- docs/modules/engine.md — how the injected bridge is threaded into qaRun
- docs/state/server-state.md — SettingsStore and Vault persistence
- docs/infra/environment.md — QA_DEBUG_MODE, QA_FIX_AGENT_BIN, QA_BRIDGE_PORT
