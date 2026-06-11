# Data Flow

> Scope: End-to-end lifecycle of a QA run from caller to verdict; all data boundaries and serialization points.
> Rendering context: Server-side (Node.js daemon)
> Project tier: 3
> Last updated: 2026-06-11

## Overview

A QA run begins when a caller (CLI or MCP) supplies a task string and a URL. The engine opens a Chrome session, runs the a11y-tree-first driver loop, passes model calls through the cost ladder, writes artifacts to disk, and returns a slim 5-field verdict. The calling coding agent pays only for those ~2K tokens.

## Ingress — Two Entry Points

CLI path: src/cli.ts parses the `qa run` command, converts flags to QaRunOptions, and calls qaRun(task, url, opts). Progress lines go to stdout.

MCP path: src/mcp-server.ts receives a qa_run tool call over stdio, extracts task and url from the tool input, and calls qaRun(). Progress is suppressed (onProgress is a no-op in MCP mode).

AGENT SEE: docs/api/route-handlers.md — full CLI and MCP contracts

## Session Setup

qaRun() calls openSession(), which calls openBrowserSession() plus Nano initialization:

1. openBrowserSession() selects the transport (cfg.via: 'cdp' or 'extension') and returns a BrowserSession with a live BrowserPort.
2. For CDP mode: CdpBrowser attaches to a headed Chrome on cfg.cdpPort. Chrome is reused if already running.
3. For extension mode: BridgeServer opens a WebSocket on cfg.bridgePort; ExtensionBrowser waits for the extension service worker to connect, then attaches to the user's tab.
4. NanoRunnerPage (or ExtensionNano in injected-bridge vibe path) starts and verifies Gemini Nano availability by querying the runner page.

AGENT SEE: docs/modules/engine.md — session lifecycle detail
AGENT SEE: docs/modules/browser-port.md — BrowserPort implementations

## Driver Loop — Per-Step Cycle

Each step in runDriverLoop (src/driver/loop.ts) follows this sequence:

1. browser.axTree() — serializes Chrome's accessibility tree via Accessibility.getFullAXTree, pruned to compact indented text with stable per-snapshot node IDs (e.g., n7 button "Place order"). This is the primary page representation (~800 tokens).
2. buildPlannerPrompt() — assembles the system prompt from task, current URL, axTree text, step history, and step budget.
3. router.planJson() — sends the prompt to the cheapest available planning adapter (rung 1 by default; rung 2 if BYOK and preferFreePlanner=false). Returns a validated PlanResult (thought + actions array).
4. Execute the batch: for each Action in the batch, call the corresponding BrowserPort method (navigate, click, type) or handle assert_visual / assert_dom / finish inline.
5. browser.drainConsole() / browser.drainNetwork() — pull buffered console errors and network failures into the StepRecord.
6. artifacts.appendAudit() — write one redacted JSON line to audit.jsonl (never includes resolved secret values).
7. onStep() callback — used by vibe mode to animate the side panel.

The loop exits when: verdict is settled (finish action), step budget exhausted, planner fails, same action repeated 3 times, or the AbortSignal fires.

AGENT NOTE: {{secret:NAME}} placeholders in type actions are resolved at execute time via the Vault. The placeholder, never the resolved value, is stored in StepRecord.action.text, audit.jsonl, and all report surfaces.

## Visual Assessment Path

Visual assertions (assert_visual) and the pass-confirmation check both take this path:

1. browser.screenshot() — PNG from Chrome via Page.captureScreenshot.
2. router.visualVerdict(png, expectation, step) — tries rung 0 (Nano) first. On 'uncertain' or error, escalates to the next rung. Each call appends a ModelTraceEntry to router.trace.
3. The NanoVerdict (verdict, summary, issues) is stored in StepRecord.visual.
4. Screenshots are saved to artifacts/<runId>/screenshots/step-NN.png and paths appended to evidence_paths.

AGENT NOTE: The Nano Prompt API requires a secure context. It runs inside a localhost runner page (port 9400), not in about:blank. In extension mode with an injected bridge, ExtensionNano calls the Prompt API inside the extension's offscreen document instead.

## Report Assembly

At run end, runDriverLoop assembles the Report:

- verdict, failing_step, console_error, reason — the slim contract fields.
- evidence_paths — paths to report.json and all screenshots.
- steps[], model_trace[] — full evidence for humans and debugging.
- tokens — real accounting: cheapModelTotal (what the cheap rungs spent), callsByRung, verdictPayloadTokens (what the calling agent pays: ~chars/4 of the slim report).

artifacts.saveReport() writes report.json to artifacts/<runId>/. If a GIF clip was recorded, its path is appended and the report rewritten.

## Recording Path (Pass Only)

When verdict is 'pass' and recording is enabled, scriptFromReport() extracts role+name locators from StepRecord.target fields and writes two files:

- generated-tests/<slug>.json — the QaScript (task, URL, steps with role+name+nth+qaId locators, lineage).
- generated-tests/<slug>.spec.ts — a Playwright .spec.ts twin for CI integration.

AGENT SEE: docs/modules/recorder.md — recorder and replay detail

## Return Path

qaRun() returns a QaRunResult (extends Report, adds recordedScript path when applicable). The CLI prints progress lines and the verdict. The MCP server returns the slim 5-field object. The calling coding agent reads ~2K tokens.

## Error Propagation

- Planner failure: reason set to "planner failed: <message>"; verdict stays 'uncertain'; loop exits.
- Action execution failure: StepRecord.ok = false, error message stored; loop continues (one retry after re-resolving the target by role+name in a fresh axTree).
- Nano unavailable: skipped; ladder starts at rung 1. Logged as a progress line.
- All adapters fail on a planning step: Error thrown; qaRun rejects.
- Secret not found: SecretNotFoundError thrown mid-step; step marked failed with a qa hint message.
- Read-only guard (host not in allowedHosts): verdict = 'uncertain', reason explains the host; loop exits immediately without burning the step budget.

## Update Triggers

- When a new entry point (transport) is added to the engine.
- When the driver loop adds a new step phase or changes the per-step cycle.
- When the Report contract (slim fields or full fields) changes.
- When the recording path emits new artifacts.
- When error propagation rules change.

## Related Docs

- docs/modules/engine.md — session lifecycle and qaRun/qaReplay detail
- docs/modules/model-ladder.md — ModelRouter and adapter rung ordering
- docs/modules/browser-port.md — BrowserPort methods
- docs/modules/recorder.md — QaScript serialization
- docs/api/route-handlers.md — CLI and MCP contracts
