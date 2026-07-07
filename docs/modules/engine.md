# Module: Engine

> Scope: The core orchestrator (src/engine.ts) - session lifecycle, qaRun, and qaReplay.
> Rendering context: Server-side (Node.js daemon)
> Project tier: 3
> Last updated: 2026-07-07

## Overview

src/engine.ts is the single file both transports (CLI and MCP) call. It exports qaRun(), qaReplay(), and openBrowserSession(). The engine owns the full lifecycle: open a Chrome session, compose the model ladder, run the driver loop, persist artifacts, optionally record a script, and close the session. Chrome and the Nano runner tab are intentionally left warm across runs; only the QA tab closes.

AGENT OWNER: src/engine.ts

## Exports

qaRun(task, url, opts) runs an AI-driven QA session against url for the given task. It resolves with QaRunResult, which is a Report plus optional recordedScript path. QaRunOptions includes maxSteps, record, config overrides, onProgress, onStep, bridge, tabId, clientId, signal, and trustTargetHost.

qaReplay(nameOrPath, opts) replays a recorded QaScript deterministically. It uses zero planner calls and Nano-only visuals. With heal=true, a failed replay re-engages the driver on the original task and re-emits the script with updated steps and healedFrom lineage.

openBrowserSession(config, deps) opens only the browser transport. It is used by no-model contract tests that need a live BrowserPort without touching Nano or the model ladder.

## Session Lifecycle

openSession() composes openBrowserSession() with Nano initialization.

For CDP mode, CdpBrowser attaches to Chrome on cfg.cdpPort. NanoRunnerPage starts a localhost HTTP server on cfg.runnerPort and opens a runner tab in the same Chrome.

For extension mode with an injected bridge, the caller owns the bridge and Chrome. ExtensionBrowser connects over the bridge. ExtensionNano accesses the Prompt API through the extension offscreen document, so there is no daemon CDP runner page.

For extension mode without an injected bridge, BridgeServer is created. Chrome may be spawned if not already alive on cfg.cdpPort, and NanoRunnerPage is used.

Chrome stays up after session.close(). The QA tab closes; Chrome and the runner tab remain warm. Never kill Chrome from the engine because the Chrome profile holds the Nano model.

AGENT NOTE: cfg.chromeProfile must be on a volume with 22 GB+ free. Gemini Nano is about 2 GB and Chrome refuses to load it otherwise. The daemon profile defaults to %LOCALAPPDATA%\qa-subagent-chrome-profile on Windows.

## Model Ladder Assembly

buildLadder() constructs all non-Nano adapters exactly once, keyed by provider:mode. qaRun() prepends NanoAdapter only when pollNanoAvailable() returns available and warmup succeeds.

The engine now passes two role pins into ModelRouter:

- cfg.navigator becomes navigatorAdapter and leads the plan-step ladder. This is the cheap per-step NAVIGATOR.
- cfg.planner becomes plannerAdapter and leads the plan-goals ladder. This is the smarter BRAIN used for goal planning and re-planning.

cfg.navigator and cfg.planner come from loadConfig(), which merges defaults, qa.config.json, SettingsStore, env, and explicit overrides. QA_NAVIGATOR_* controls the NAVIGATOR; QA_PLANNER_* controls the BRAIN.

If a role selects nano, buildLadder() resolves the pin name to "nano". Nano can serve visual-verdict and plan-step when it is available, but it never serves plan-goals. If Nano is unavailable or the pin is not present in candidates for a role, ModelRouter falls through to the next available adapter.

API keys for Gemini, Anthropic, OpenAI, OpenRouter, and GLM are read from the Vault first where supported, then from environment variables as a fallback. Gemini also honors cfg.geminiApiKey. OpenAI-compatible API adapters are constructed through src/router/gateway.ts so OPENAI_BASE_URL, OPENROUTER_BASE_URL, and GLM_BASE_URL can route the same adapter through compatible gateways.

AGENT SEE: docs/modules/model-ladder.md - full adapter list, capabilities, role pins, and ladder ordering

## Nano Availability Polling

pollNanoAvailable() polls every 5 seconds for up to 60 seconds when Nano reports downloading or downloadable. This handles a fresh Chrome that needs time to re-validate the on-disk model after a cold start. On available, nano.warmup() pre-loads the model session. On any other terminal state, the ladder starts without Nano and falls back to higher rungs.

Nano is a $0 visual judge and can act as the NAVIGATOR for plan-step, but it is never the BRAIN. plan-goals always requires a non-Nano adapter.

## Driver and Trace Flow

qaRun() constructs ModelRouter with preferFreePlanner, navigatorAdapter, and plannerAdapter, then passes it to runDriverLoop(). The driver records router.trace into the final report. Each ModelTraceEntry includes capability, rung, adapter, elapsed milliseconds, escalation note, and optional usage copied from adapter.lastUsage.

Token accounting therefore lives in the model trace. Providers that expose prompt/output/total/cached token counts populate usage; Nano and local adapters may omit it.

When cfg.actionCache is enabled, qaRun() constructs FileActionCache(cfg.actionCacheDir) and passes it to runDriverLoop(). The driver records action_cache metadata in the full report: enabled, hits, misses, stale, and stored. CLI `qa run` exposes `--action-cache` and `--no-action-cache` for one-run overrides; QA_ACTION_CACHE and QA_ACTION_CACHE_DIR cover automation defaults.

qaRun() also passes cfg.assertionPolicy into runDriverLoop(). The driver applies it to explicit assert_visual actions and the final finish:pass confirmation, writing assertion_trace entries in the full report while keeping the slim MCP response unchanged.

For `assert_visual` mode `video`, the driver uses the existing CDP screencast recorder as best-effort per-step evidence when cdpClient() is available. Current model adapters still judge the screenshot fallback; video-capable model upload is intentionally not enabled until an adapter advertises that support.

## GIF Clip Recording

When cfg.recordClip is true and the BrowserPort exposes cdpClient(), startClipRecorder() is called with a 5-second timeout guard. If the clip recorder starts successfully, it is stopped after the run, the GIF path is appended to evidence_paths, and the report is rewritten.

AGENT AVOID: Do not enable clip recording in extension transport without resolving the chrome.debugger/Page.startScreencast gap documented in TODO.md. The 5-second guard is a safety net, not a fix.

## Replay and Self-Heal

qaReplay loads a QaScript by name or path, calls replayScript(), and returns the verdict. Replay has no planner calls and uses Nano for recorded visual checks. On failure with heal=true, qaReplay invokes qaRun with record=false, restores the original script name, attaches healedFrom lineage, and re-emits the script through saveScript().

## Update Triggers

- When a new transport is added.
- When Nano polling or Nano role support changes.
- When model ladder assembly, role pins, or key sources change.
- When session.close() changes.
- When QaRunOptions or QaRunResult add or remove fields.
- When report trace or token accounting fields change.
- When action-cache config, bypass controls, or report metadata change.
- When assertion policy routing or report metadata change.

## Related Docs

- docs/architecture/data-flow.md - end-to-end run lifecycle
- docs/modules/model-ladder.md - adapter construction and rung ordering
- docs/modules/browser-port.md - BrowserPort implementations
- docs/modules/action-cache.md - verified action-cache helpers
- docs/modules/recorder.md - script recording and replay
- docs/infra/environment.md - config keys and env vars
