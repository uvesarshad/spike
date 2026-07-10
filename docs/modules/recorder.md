# Module: Recorder

> Scope: QaScript recording (src/recorder/script.ts) and $0 deterministic replay (src/recorder/replay.ts).
> Rendering context: Server-side (Node.js daemon)
> Project tier: 3
> Last updated: 2026-07-09

## Overview

After every passing qaRun, the recorder serializes the run into a QaScript: a JSON file keyed by accessibility role+name locators. The same script can be replayed at $0 (Nano-only visuals, zero planner calls) for regression checks. A Playwright .spec.ts twin is emitted alongside for CI integration. Failed replays can optionally self-heal by re-engaging the driver.

AGENT OWNER: src/recorder/

## QaScript Structure (src/recorder/script.ts)

A QaScript contains:

- name: string - kebab-case slug derived from the task.
- task: string - the original plain-English task description.
- url: string - the starting URL.
- createdAt: ISO timestamp.
- steps: ScriptStep[] - each step contains role (ARIA role), name (ARIA name), optional nth (disambiguation index), optional qaId (data-qa-id fallback), action type, and any text, selected value, key, navigation URL, or assert expectation.
- healedFrom?: { runId, failedStep, healedAt } - lineage when the script was re-emitted by self-heal.

AGENT NOTE: ScriptStep locators use role+name, not nodeId. NodeIds are per-snapshot and meaningless across runs. The nth field disambiguates when multiple nodes share the same role+name (e.g., two "button Add to cart" elements on a products page). qaId is a best-effort fallback for name-less nodes; it is stamped via BrowserPort.stampQaId() and does not survive a page reload.

AGENT NOTE (Phase 9 action parity): `upload_file`/`blur` steps carry a single `target` like click/hover. `upload_file.paths` are made portable at record time (`portablePath()` in script.ts: absolute paths become relative to `process.cwd()`; a path referencing `{{secret:...}}` is rejected outright — upload paths must never embed secrets). `drag_and_drop` has TWO locators (`source` + optional `target`, the drop zone) — StepRecord only carries ONE `target` slot, so the driver loop resolves both directly onto the `drag_and_drop` Action itself as `sourceTarget`/`targetTarget` (resolved post-execution from the live a11y tree, NEVER model-emitted — absent from the navigator's JSON schema) and `scriptFromReport` reads them from `s.action`, not `s.target`; a drag with no resolved `sourceTarget` is skipped (same "no target, no recording" convention as click/hover). `mouse` records raw page coordinates (x, y) with no locator — inherently less resilient across layout changes than a role+name step. `open_tab`/`switch_tab`/`close_tab`: a runtime CDP target id would not survive a later replay run, so `switch_tab`/`close_tab` record a `tabIndex` instead (0 = the tab active when the script starts, N >= 1 = the Nth `open_tab` call in this script, creation order) — `tabIndexFor()` in script.ts derives it by scanning preceding `open_tab` StepRecords for a `target.name` match (the recorder reuses that single slot to carry the runtime id `open_tab` returned, purely for this correlation). Replay tracks the REAL ids/indices returned by `browser.openTab()` as it runs (`openedTabIds` in replay.ts) to resolve `close_tab`'s tabIndex back to a real id; `close_tab #0` (the original tab) cannot be replayed and fails with a clear error. `script` steps (Phase 10) persist the validated `ScriptRunnerStep[]` verbatim and are RE-VALIDATED (never re-trusted) at replay time via `validateScriptSteps()` before `runScriptSteps()` executes them — see script-runner.md.

AGENT NOTE (Phase 15 extraction): `extract` steps gained an optional `prompt` field and `target` became optional (model-assisted mode may target the whole page, no nodeId). Replay NEVER spends a model call — a `prompt`-mode extract step is SKIPPED at replay time with a `[SKIPPED: model-assisted extraction spends a model call — replay stays $0]` note (mirrors the existing Nano-unavailable visual-assertion skip); a later `{{run.*}}` reference to that key then fails with a precise "not found" error rather than silently resolving to nothing.

## Recording Flow

scriptFromReport(report) - called by qaRun after a passing run. Iterates StepRecord[], extracts each step's target (role+name+nth+qaId), action type, and payload. Type steps carry text placeholders, extract steps carry key/pattern, select_option carries the selected value, press_key carries the key, assert_visual carries expectation plus optional mode, and navigate steps carry the URL.

saveScript(script) - writes generated-tests/<slug>.json and generates the Playwright .spec.ts twin via buildPlaywrightSpec(). Returns both paths.

loadScript(nameOrPath) - resolves a script by name (generated-tests/<name>.json) or by absolute/relative path.

diffScripts(oldScript, newScript) - returns a human-readable summary of what changed between two versions of the same script (used by the self-heal progress line).

AGENT NOTE: Runtime data placeholders are replay-aware. Replay preserves `{{run.*}}` expressions in ScriptStep.text, creates a fresh RunDataState at replay start, resolves placeholders immediately before browser.type(), and keeps the JSON script unchanged. Extract steps call recordExtraction() so later replay steps can use values like `{{run.orderId}}`.

## Replay Flow (src/recorder/replay.ts)

replayScript(browser, nano, artifacts, script, opts) - replays the script without a planner. For each ScriptStep:

1. Resolve the target node by role+name (using findByRoleName on a fresh axTree). If nth is set, use the nth match. If role+name fails, fall back to qaId (browser.findByQaId if available).
2. Execute the action: navigate, click, hover, type with runtime placeholder resolution, press_key, select_option, reload, go_back, upload_file, drag_and_drop, blur, mouse, open_tab/switch_tab (by tabIndex)/close_tab, script (re-validated, then run via the script-runner executor), extract (DOM path; a prompt-mode step is skipped — see the Phase 15 note above), assert_dom check, or assert_visual via nano.verdict.
3. Drain console and network; record in a StepRecord.

No model calls are made for planning - only Nano for assert_visual steps. This makes a replay cost $0 (plus minimal Nano cycles if visual asserts are present).

Returns a Report with verdict, steps, and evidence_paths. If replay fails and heal=true was passed to qaReplay (in engine.ts), the engine re-engages the full driver loop on the original task.

## Playwright Twin

buildPlaywrightSpec() emits a .spec.ts file co-located with the JSON script. Each ScriptStep becomes a Playwright call where possible: page.goto(url), page.getByRole(role, { name }).click(), .hover(), .fill(text), .selectOption(value), page.keyboard.press(key), page.reload(), page.goBack(), .setInputFiles(paths) for upload_file, .dragTo(target) for drag_and_drop (a comment when no drop target was resolved), .blur(), page.mouse.move/down/up for mouse, or expect(...).toBeVisible() for assert_dom. Extract, visual/video assertions, open_tab/switch_tab/close_tab, and script steps are emitted as comments because the QA subagent owns those semantics during `qa replay` (tab/script Playwright equivalents are noted in the comment: context.newPage(), tracked pages[], page.close()).

AGENT NOTE: The .spec.ts twin is a best-effort translation. It is not kept in sync after the JSON script is modified manually. Regenerate it by running qa replay <name> --heal or by re-recording.

## Update Triggers

- When StepRecord.target gains or loses fields (nth, qaId, new locator strategies).
- When new action types are added to the Action union (they must be handled in scriptFromReport and replayScript).
- When the Playwright spec generation rules change.
- When runtime placeholder or extract replay semantics change.
- When the generated-tests/ directory path changes (loadScript would need updating).

## Related Docs

- docs/architecture/data-flow.md - recording is triggered at the end of the qaRun flow
- docs/modules/engine.md - qaReplay and self-heal logic
- docs/modules/browser-port.md - BrowserPort.stampQaId, axTree, and the new Phase 9 action methods
- docs/modules/script-runner.md - the `script` action's validator/executor a recorded `script` ScriptStep re-validates and re-runs
