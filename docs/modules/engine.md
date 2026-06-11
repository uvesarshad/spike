# Module: Engine

> Scope: The core orchestrator (src/engine.ts) — session lifecycle, qaRun, and qaReplay.
> Rendering context: Server-side (Node.js daemon)
> Project tier: 3
> Last updated: 2026-06-11

## Overview

src/engine.ts is the single file both transports (CLI and MCP) call. It exports qaRun(), qaReplay(), and openBrowserSession(). The engine owns the full lifecycle: open a Chrome session, compose the model ladder, run the driver loop, persist artifacts, optionally record a script, and close the session. Chrome and the Nano runner tab are intentionally left warm across runs; only the QA tab closes.

AGENT OWNER: src/engine.ts

## Exports

qaRun(task, url, opts) — Runs an AI-driven QA session against url for the given task. Resolves with QaRunResult (a Report plus an optional recordedScript path). Accepts QaRunOptions: maxSteps, record (default true), config overrides, onProgress, onStep, bridge (caller-owned, for vibe mode), tabId, clientId, signal (AbortSignal).

qaReplay(nameOrPath, opts) — Replays a recorded QaScript deterministically. Zero planner calls; Nano-only visuals. With heal=true, a failed replay re-engages the driver on the original task and re-emits the script with updated steps and healedFrom lineage.

openBrowserSession(config, deps) — Opens only the browser transport (no Nano, no model ladder). Used by no-model contract tests (test/m1.browser-port.ts) that need a live BrowserPort without touching the Nano profile.

## Session Lifecycle

openSession() (internal) composes openBrowserSession() with Nano initialization:

For CDP mode: CdpBrowser is attached to Chrome on cfg.cdpPort. NanoRunnerPage starts a localhost HTTP server (cfg.runnerPort) and opens a runner tab in the already-running Chrome.

For extension mode with injected bridge (vibe daemon path): the caller owns the bridge and the Chrome. ExtensionBrowser connects over the bridge. ExtensionNano accesses the Prompt API through the extension's offscreen document — no daemon CDP page, no runner tab.

For extension mode without injected bridge (standalone): BridgeServer is created; Chrome may be spawned if not already alive on cfg.cdpPort. NanoRunnerPage is used.

Chrome stays up after session.close(). The QA tab closes; Chrome and the runner tab remain warm. Never kill Chrome from the engine — Chrome's profile holds the ~2GB Nano model.

AGENT NOTE: cfg.chromeProfile must be on a volume with 22 GB+ free. The Gemini Nano model is ~2 GB and Chrome refuses to load it otherwise (availability() returns 'unavailable'). The daemon profile defaults to %LOCALAPPDATA%\qa-subagent-chrome-profile (C: drive on Windows).

## Model Ladder Assembly

buildLadder() (internal) constructs all adapters exactly once, keyed by provider:mode. The user's PlannerSelection (from cfg.planner, which merges SettingsStore + env) is pinned to the front of the planning ladder. Adapters for unavailable providers (no key, CLI missing) return available()===false and are silently skipped by ModelRouter.

API keys for Anthropic, OpenAI, and OpenRouter are read from the Vault first, then from environment variables as a fallback.

AGENT SEE: docs/modules/model-ladder.md — full adapter list and ladder ordering

## Nano Availability Polling

pollNanoAvailable() polls every 5 seconds for up to 60 seconds when Nano reports 'downloading' or 'downloadable'. This handles a fresh Chrome that needs ~60s to re-validate the on-disk model after a cold start. On 'available', nano.warmup() is called to pre-load the model session; on any other terminal state, the ladder starts at rung 1 with a progress notice.

## GIF Clip Recording

When cfg.recordClip is true and the BrowserPort exposes a cdpClient(), startClipRecorder() is called with a 5-second timeout guard (chrome.debugger silently never answers Page.startScreencast in extension mode). If the clip recorder starts successfully, it is stopped after the run, the GIF path is appended to evidence_paths, and the report is rewritten.

AGENT AVOID: Do not enable clip recording in extension transport without resolving the chrome.debugger/Page.startScreencast gap documented in TODO.md. The 5-second guard is a safety net, not a fix.

## Replay and Self-Heal

qaReplay loads a QaScript by name or path (generated-tests/<slug>.json), calls replayScript(), and returns the verdict. On failure with heal=true, it re-invokes qaRun with record=false, restores the original script name, attaches healedFrom lineage, and re-emits the script via saveScript().

## Update Triggers

- When a new transport is added (new BrowserPort implementation composable here).
- When the Nano polling strategy changes.
- When the model ladder assembly changes (new adapter types or key sources).
- When the session.close() contract changes.
- When QaRunOptions or QaRunResult add or remove fields.

## Related Docs

- docs/architecture/data-flow.md — end-to-end run lifecycle
- docs/modules/model-ladder.md — adapter construction and rung ordering
- docs/modules/browser-port.md — BrowserPort implementations
- docs/modules/recorder.md — script recording and replay
- docs/infra/environment.md — config keys and env vars
