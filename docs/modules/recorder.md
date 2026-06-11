# Module: Recorder

> Scope: QaScript recording (src/recorder/script.ts) and $0 deterministic replay (src/recorder/replay.ts).
> Rendering context: Server-side (Node.js daemon)
> Project tier: 3
> Last updated: 2026-06-11

## Overview

After every passing qaRun, the recorder serializes the run into a QaScript — a JSON file keyed by accessibility role+name locators. The same script can be replayed at $0 (Nano-only visuals, zero planner calls) for regression checks. A Playwright .spec.ts twin is emitted alongside for CI integration. Failed replays can optionally self-heal by re-engaging the driver.

AGENT OWNER: src/recorder/

## QaScript Structure (src/recorder/script.ts)

A QaScript contains:

- name: string — kebab-case slug derived from the task.
- task: string — the original plain-English task description.
- url: string — the starting URL.
- createdAt: ISO timestamp.
- steps: ScriptStep[] — each step contains role (ARIA role), name (ARIA name), optional nth (disambiguation index), optional qaId (data-qa-id fallback), action type, and any type text or assert expectation.
- healedFrom?: { runId, failedStep, healedAt } — lineage when the script was re-emitted by self-heal.

AGENT NOTE: ScriptStep locators use role+name, not nodeId. NodeIds are per-snapshot and meaningless across runs. The nth field disambiguates when multiple nodes share the same role+name (e.g., two "button Add to cart" elements on a products page). qaId is a best-effort fallback for name-less nodes; it is stamped via BrowserPort.stampQaId() and does not survive a page reload.

## Recording Flow

scriptFromReport(report) — called by qaRun after a passing run. Iterates StepRecord[], extracts each step's target (role+name+nth+qaId), action type, and text payload. Assert_visual steps carry the expectation string. Navigate steps carry the URL.

saveScript(script) — writes generated-tests/<slug>.json and generates the Playwright .spec.ts twin via buildPlaywrightSpec(). Returns both paths.

loadScript(nameOrPath) — resolves a script by name (generated-tests/<name>.json) or by absolute/relative path.

diffScripts(oldScript, newScript) — returns a human-readable summary of what changed between two versions of the same script (used by the self-heal progress line).

## Replay Flow (src/recorder/replay.ts)

replayScript(browser, nano, artifacts, script, opts) — replays the script without a planner. For each ScriptStep:

1. Resolve the target node by role+name (using findByRoleName on a fresh axTree). If nth is set, use the nth match. If role+name fails, fall back to qaId (browser.findByQaId if available).
2. Execute the action (navigate, click, type, assert_dom check, or assert_visual via nano.verdict).
3. Drain console and network; record in a StepRecord.

No model calls are made for planning — only Nano for assert_visual steps. This makes a replay cost $0 (plus minimal Nano cycles if visual asserts are present).

Returns a Report with verdict, steps, and evidence_paths. If replay fails and heal=true was passed to qaReplay (in engine.ts), the engine re-engages the full driver loop on the original task.

## Playwright Twin

buildPlaywrightSpec() emits a .spec.ts file co-located with the JSON script. Each ScriptStep becomes a Playwright locator call: page.getByRole(role, { name }) for click/type, page.getByRole(role, { name }).fill(text) for type, expect(page.getByRole(role, { name })).toBeVisible() for assert_dom. The spec includes the page.goto(url) at the top.

AGENT NOTE: The .spec.ts twin is a best-effort translation. It is not kept in sync after the JSON script is modified manually. Regenerate it by running qa replay <name> --heal or by re-recording.

## Update Triggers

- When StepRecord.target gains or loses fields (nth, qaId, new locator strategies).
- When new action types are added to the Action union (they must be handled in scriptFromReport and replayScript).
- When the Playwright spec generation rules change.
- When the generated-tests/ directory path changes (loadScript would need updating).

## Related Docs

- docs/architecture/data-flow.md — recording is triggered at the end of the qaRun flow
- docs/modules/engine.md — qaReplay and self-heal logic
- docs/modules/browser-port.md — BrowserPort.stampQaId and axTree for replay resolution
