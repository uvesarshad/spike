# Data Flow

> Scope: End-to-end lifecycle of a QA run from caller to verdict; all data boundaries and serialization points.
> Rendering context: Server-side (Node.js daemon)
> Project tier: 3
> Last updated: 2026-07-18

## Overview

A QA run begins when a caller (CLI or MCP) supplies a task string and a URL. The engine opens a Chrome session, runs the a11y-tree-first driver loop, passes model calls through the cost ladder, writes artifacts to disk, and returns a slim 5-field verdict. The driver uses a two-tier model split: the Brain makes the initial sub-goal plan and rare re-plans; the Navigator reads the page and chooses 1-3 actions per step. The calling coding agent pays only for the returned ~2K-token slim report.

## Ingress - Two Entry Points

CLI path: src/cli.ts parses the `spike run` command, converts flags to QaRunOptions, and calls qaRun(task, url, opts). Progress lines go to stdout.

MCP path: src/mcp-server.ts receives a qa_run tool call over stdio, extracts task and url from the tool input, and calls qaRun(). Progress is suppressed (onProgress is a no-op in MCP mode).

AGENT SEE: docs/api/route-handlers.md - full CLI and MCP contracts

## Pre-Run Replay Match (Phase 14)

Before qaRun() opens a browser session or builds the model ladder, it checks for a $0 shortcut:

1. Unless opts.replay is false (CLI `--no-replay`), matchReplayScript() (src/recorder/matcher.ts) scores every generated-tests/*.json script's task+url against the new request.
2. A score at or above the confidence threshold triggers qaReplay() on that script instead of a fresh AI pass - deterministic, Nano-only visuals, no Navigator/Brain tokens spent.
3. If the replay comes back 'fail', or replay itself throws, the run falls back to a fresh AI pass (runFreshAiPass()) with a progress line explaining why.
4. A successful non-fail replay returns immediately as a QaRunResult with `replayMatch: { name, score }` attached; the report is persisted and the run never reaches Session Setup below.

AGENT NOTE: qaReplay() invoked from a fresh AI pass's own re-run path (`spike fix` follow-ups, etc.) passes `replay: false` so the matcher never re-matches the script that just failed against itself.

AGENT SEE: docs/modules/recorder.md - matcher scoring detail

## Session Setup

When no replay match short-circuits the run, qaRun() calls runFreshAiPass(), which calls openSession() (in turn openBrowserSession() plus Nano initialization):

1. openBrowserSession() selects the transport (cfg.via: 'cdp' or 'extension') and returns a BrowserSession with a live BrowserPort.
2. For CDP mode: CdpBrowser attaches to a headed Chrome on cfg.cdpPort. Chrome is reused if already running.
3. For extension mode: BridgeServer opens a WebSocket on cfg.bridgePort; ExtensionBrowser waits for the extension service worker to connect, then attaches to the user's tab.
4. NanoRunnerPage (or ExtensionNano in injected-bridge vibe path) starts and verifies Gemini Nano availability by querying the runner page.

AGENT SEE: docs/modules/engine.md - session lifecycle detail
AGENT SEE: docs/modules/browser-port.md - BrowserPort implementations

## Driver Loop - Brain and Navigator

runDriverLoop (src/driver/loop.ts) starts by navigating to the URL and draining initial page-load noise. It then checks whether any adapter supports `plan-goals`:

1. Brain available: browser.axTree() captures the current page, buildGoalPlannerPrompt() builds the Brain prompt, and router.planGoals() returns a GoalPlan: ordered goals, a hint, or a final verdict.
2. Brain unavailable or initial Brain failure: the run degrades to navigator-only mode with one implicit goal equal to the task.
3. If the Brain returns goals, the Navigator works through them one at a time. Completed goals stay completed across re-plans.

Each Navigator step follows this sequence:

1. browser.axTree() serializes Chrome's accessibility tree via Accessibility.getFullAXTree, pruned to compact indented text with stable per-snapshot node IDs (e.g., n7 button "Place order"). This is the primary page representation.
2. If cfg.actionCache is enabled, FileActionCache searches for records matching current URL, goal, and page signature. A cached action executes only when that context has a single unambiguous record and its effect verifies; ambiguous or stale hits fall back to the Navigator.
3. buildNavigatorPrompt() assembles the task, current URL, axTree text, step history, current goal, goal list, optional Brain hint, and remaining budget.
4. router.planJson() sends the prompt to the `plan-step` ladder led by the configured Navigator. The response validates as PlanResult: actions, goalComplete, or blocked. Invalid JSON is retried once with the validation error.
5. goalComplete advances to the next goal. blocked escalates to the Brain if one is available, or ends honestly in navigator-only mode.
6. Action batches contain 1-3 actions. finish, assert_visual, and assert_dom run alone even if the model bundled more actions.
7. Each action executes through BrowserPort (navigate, click, hover, type, press_key, select_option, wait, reload, go_back, blur, upload_file, drag_and_drop, mouse move/down/up, open_tab, switch_tab, close_tab) or inline handling (assert_visual, assert_dom, extract, finish). Type actions resolve {{run.*}} first, then {{secret:NAME}} at execute time only.
7a. A `script` action takes a separate path: validateScriptSteps() (src/driver/script-runner/validator.ts) structurally validates the allowlisted step list against BrowserPort verbs before anything executes - a rejected script never runs a single step and surfaces as a normal failed StepRecord. A validated script runs via runScriptSteps() (src/driver/script-runner/executor.ts), which resolves {{run.*}}/{{secret:NAME}} at execute time exactly like the main `type` action and never returns resolved values to the caller. Script failures feed the same stuck machinery (repeated action, blocked, per-goal overflow) as any other failed step.
8. browser.drainConsole() / browser.drainNetwork() pull buffered console errors and network failures into the StepRecord after each action, not just after the batch.
9. Successful final actions in a batch can be written back to the action cache after effect verification; raw resolved secrets are never cached.
10. artifacts.appendAudit() writes one redacted JSON line per executed action (never includes resolved secret values).
11. onStep() callback is used by vibe mode to animate the side panel.

AGENT NOTE: The Brain is re-consulted on Navigator `blocked`, same single action repeated 3 times, invalid Navigator JSON twice, per-goal step overflow, or finish:pass when the confirmation visual disagrees. Brain recovery may replace remaining goals, provide a one-shot Navigator hint, or return a final verdict. Consecutive Brain escalations without Navigator progress are capped.

The loop exits when: verdict is settled, global step budget is exhausted, the AbortSignal fires, read-only host guard blocks a mutation, the Brain returns a final verdict, no Brain can recover a stuck Navigator, Brain recovery is capped, initial planning returns no goals, or planner recovery fails.

AGENT NOTE: {{secret:NAME}} placeholders in type actions are resolved at execute time via the Vault. The placeholder, never the resolved value, is stored in StepRecord.action.text, audit.jsonl, and all report surfaces.

AGENT NOTE: Action-cache writes must receive the original redacted Action, never the resolved type text after Vault substitution. Cache values may store `{{secret:NAME}}` placeholders but must reject raw secret-like strings.

## Runtime Data Hook Points

src/run-data/ owns non-secret same-run values and placeholder resolution for `{{run.email}}`, `{{run.shortid}}`, `{{run.name}}`, `{{run.phone}}`, and extracted keys such as `{{run.orderId}}`. runDriverLoop creates RunDataState at run start, resolves `{{run.*}}` immediately before type actions, and keeps the original placeholder-bearing action in StepRecord, reports, and scripts. `extract` reads visible node (or, with `nodeId` omitted, whole-page) text, then either applies a regex `pattern` ($0 DOM-text path) or, when `prompt` is given, sends the page/subtree text to a cheap text model for a model-assisted pull (Phase 15) - either way the resolved value is stored for later same-run placeholders. src/email/ owns the EmailProvider interface plus FakeLocalEmailProvider for local OTP-style tests; real email providers are intentionally deferred.

## Visual Assessment Path

Visual assertions (assert_visual) and the pass-confirmation check both take this path:

1. browser.screenshot() - PNG from Chrome via Page.captureScreenshot. `assert_visual.mode: "video"` attempts a short per-step CDP GIF clip when the transport exposes cdpClient(), stores it on StepRecord.video/evidence_paths when available, and falls back to screenshot judging when no video-capable model route is available.
2. runVisualAssertion() applies cfg.assertionPolicy: single ladder, fail-on-disagreement, or arbiter-on-disagreement.
3. Model calls append ModelTraceEntry records with capability `visual-verdict`; assertion policy groups append assertion_trace records to the full report.
4. The NanoVerdict-compatible result is stored in StepRecord.visual.
5. Screenshots are saved to artifacts/<runId>/screenshots/step-NN.png and paths appended to evidence_paths.

finish:pass is accepted only after one confirmation visual passes. If confirmation fails or is uncertain, the Brain arbitrates when available; navigator-only mode honors the visual result directly.

AGENT NOTE: The Nano Prompt API requires a secure context. It runs inside a localhost runner page (port 9400), not in about:blank. In extension mode with an injected bridge, ExtensionNano calls the Prompt API inside the extension's offscreen document instead.

## Report Assembly

At run end, runDriverLoop assembles the Report:

- verdict, failing_step, console_error, reason - the slim contract fields.
- evidence_paths - paths to report.json and all screenshots.
- steps[], model_trace[], assertion_trace[], run_data, action_cache - full evidence for humans and debugging.
- tokens - real accounting: cheapModelTotal (what the cheap rungs spent), cheapModelCached, callsByRung, verdictPayloadTokens (what the calling agent pays: ~chars/4 of the slim report), navigatorCalls, brainCalls, visualCalls, navigatorTokens, brainTokens.

The role split is derived from model_trace capability: `plan-step` = Navigator, `plan-goals` = Brain, and `visual-verdict` = visual checks. Brain calls should scale with stuck/re-plan events, not with total step count.

artifacts.saveReport() writes report.json to artifacts/<runId>/. If a GIF clip was recorded, its path is appended and the report rewritten.

## Recording Path (Pass Only)

When verdict is 'pass' and recording is enabled, scriptFromReport() extracts role+name locators from StepRecord.target fields and persists the executable action payloads, including click, hover, type, press_key, select_option, reload, go_back, navigation, assertions, extract, upload_file, drag_and_drop, blur, mouse, and tab management (open_tab/switch_tab/close_tab, keyed by creation-order tabIndex rather than a raw runtime tab id). `script` actions are recorded as-is (the validated step list replays verbatim). It writes two files:

- generated-tests/<slug>.json - the QaScript (task, URL, steps with role+name+nth+qaId locators, lineage).
- generated-tests/<slug>.spec.ts - a Playwright .spec.ts twin for CI integration.

AGENT SEE: docs/modules/recorder.md - recorder and replay detail

## Return Path

qaRun() returns a QaRunResult (extends Report, adds recordedScript path when applicable). The CLI prints progress lines and the verdict. The MCP server returns the slim 5-field object. The calling coding agent reads ~2K tokens.

## Error Propagation

- Initial Brain failure: degrade to navigator-only with one implicit goal.
- Brain recovery failure: reason set to "planner failed while recovering from ..."; verdict stays 'uncertain'; loop exits.
- Navigator invalid JSON twice, blocked, repeated action 3 times, or per-goal overflow: escalate to Brain when available; otherwise verdict stays 'uncertain' with a stuck reason.
- Action execution failure: StepRecord.ok = false, error message stored; loop continues unless another exit condition is met (one retry after re-resolving the target by role+name in a fresh axTree).
- Nano unavailable: skipped; ladder starts at rung 1. Logged as a progress line.
- All adapters fail for a Navigator step: escalates to Brain; if recovery fails, the run exits uncertain.
- Secret not found: SecretNotFoundError thrown mid-step; step marked failed with a qa hint message.
- Read-only guard (host not in allowedHosts): verdict = 'uncertain', reason explains the host; loop exits immediately without burning the step budget.

## Update Triggers

- When a new entry point (transport) is added to the engine.
- When the driver loop adds a new step phase or changes the per-step cycle.
- When the action cache is wired into the driver loop or its hit/miss metadata changes.
- When Brain/Navigator re-plan triggers or exit conditions change.
- When the Report contract (slim fields or full fields) changes.
- When the recording path emits new artifacts.
- When error propagation rules change.
- When the pre-run replay matcher's scoring or fallback behavior changes.
- When the script-runner's allowlisted verb set or validation rules change.

## Related Docs

- docs/modules/engine.md - session lifecycle and qaRun/qaReplay detail
- docs/modules/model-ladder.md - ModelRouter and adapter rung ordering
- docs/modules/browser-port.md - BrowserPort methods
- docs/modules/recorder.md - QaScript serialization and the pre-run replay matcher
- docs/modules/script-runner.md - allowlisted/AST-validated secure custom-step runner
- docs/api/route-handlers.md - CLI and MCP contracts
