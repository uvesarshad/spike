# Module: Script Runner

> Scope: the `script` action's secure, allowlisted step-list validator and executor (src/driver/script-runner/).
> Rendering context: Server-side (Node.js daemon)
> Project tier: 3
> Last updated: 2026-07-09

## Overview

The `script` action (Phase 10) is a constrained escape hatch for app-specific flows that are awkward to model one action at a time: a known multi-field form, a fixed sequence of clicks, etc. Its body is a SMALL, ALLOWLISTED, declarative step list over BrowserPort verbs — plain JSON data, never raw Playwright/Node code, and never `eval`. The module has three pieces: `schema.ts` (what a step may look like), `validator.ts` (structural + pattern rejection BEFORE anything executes), `executor.ts` (runs an already-validated list against BrowserPort only).

AGENT OWNER: src/driver/script-runner/

## Why not just eval a code string

An `eval`-based DSL would let a compromised/hallucinating model (or a hand-edited recorded script) reach `fs`, `process`, `require`, network APIs, or prototype pollution. The script runner instead accepts a fixed set of VERB NAMES with typed, flat parameters — the same shapes the driver's own `Action` union uses for the equivalent single actions (`src/driver/actions.ts`) — and a hand-written `switch` in `executor.ts` dispatches each verb to the matching `BrowserPort` method. There is no code path from a script step's string fields to anything other than a `BrowserPort` call or a `{{run.*}}`/`{{secret:*}}` placeholder resolution. Nothing in this module ever constructs or evaluates a JS expression from step data.

## Allowlisted verbs (src/driver/script-runner/schema.ts)

`navigate, click, type, hover, press_key, select_option, reload, go_back, wait, assert_dom, extract, upload_file, drag_and_drop, blur, mouse` — the SAME verbs the main driver loop's `Action` union supports, MINUS `assert_visual`, `finish`, and `script` itself (no vision/model calls, no meta-actions, no recursion). `extract` here is DOM-text/regex only (no `prompt` field) — model-assisted extraction stays a top-level driver action, not something a sandboxed script triggers.

`ScriptRunnerStepSchema` is a zod discriminated union; every member is `.strict()` — an unknown/extra field on an otherwise-valid step is rejected outright, not silently dropped. `SCRIPT_STEP_JSON_SCHEMA` is the flat JSON-schema twin handed to the navigator model (same convention as `PLAN_JSON_SCHEMA` in actions.ts: one object shape, optional fields, rather than a real discriminated union — model function-calling schemas are more reliable flat).

Caps: `SCRIPT_MAX_STEPS` (20) and `SCRIPT_MAX_WALL_MS` (30 000 ms) bound both validation and execution cost — a script this small is a targeted escape hatch, not a general automation language.

## Validator (src/driver/script-runner/validator.ts)

`validateScriptSteps(input: unknown): ScriptValidationResult` runs BEFORE any BrowserPort call:

1. Reject a non-array body, an empty array, or more than `SCRIPT_MAX_STEPS` steps.
2. zod-parse each step against `ScriptRunnerStepSchema` — an unknown `type`, a missing required field, or an extra field all fail here.
3. Recursively scan every string field (and reject `__proto__`/`constructor`/`prototype` object KEYS) for code-injection markers: `import(`, `require(`, `process.`, `eval(`, `new Function`, `Function(`, `__proto__`, `.constructor[(`, `prototype[.`, `child_process`, `fs.`, `XMLHttpRequest`, `fetch(`, `WebSocket(`, and template-literal interpolation (`` `...${`` ``). These patterns are matched as CODE SHAPES (a call, a member-access chain), not bare words — a URL like `/fetch-results` is not flagged.

A validation failure returns `{ ok: false, reason }` and NEVER throws — the caller (loop.ts) treats a rejected `script` action as a normal failed step, which feeds the existing stuck-detection machinery (repeated-action loop detection, `blocked`, per-goal overflow) rather than a special-cased crash path.

## Executor (src/driver/script-runner/executor.ts)

`runScriptSteps(browser, steps, runData, vault, opts?)` takes ONLY an already-validated `ScriptRunnerStep[]` (never call it on raw input) and runs each step sequentially against `BrowserPort`, under a wall-time deadline (`opts.maxWallMs`, default `SCRIPT_MAX_WALL_MS`). `{{run.*}}` placeholders resolve via `resolveRunPlaceholders` and `{{secret:NAME}}` via the vault, both AT EXECUTE TIME ONLY — mirrors `loop.ts`'s own `type`-action secret handling exactly (same regex, same "secret not found" error text). The resolved value is a local variable passed straight to `browser.type()`; it is never returned, logged, or attached to any record the executor produces, so a resolved secret cannot leak into a report even if the caller logs the executor's return value.

Returns `{ ok, executedSteps, error? }` — never throws. A step failure (a BrowserPort call rejecting, or the wall-time budget running out) stops the remaining steps and reports how many ran.

## Wiring into the driver loop (src/driver/loop.ts)

The `script` action: (1) is forced to be the ONLY action in its batch (same rule as `finish`/`assert_visual`/`assert_dom`); (2) is gated by the same read-only-host mutation guard as click/type; (3) validates via `validateScriptSteps(action.steps)` — on failure, the step is marked `ok: false` with the rejection reason and NOTHING executes; (4) on success, runs `runScriptSteps(browser, validated.steps, runData, vault)` and marks the step failed if the executor reports `ok: false`.

## Recorder/replay (src/recorder/script.ts, src/recorder/replay.ts)

A passed run's `script` step is persisted VERBATIM as `{ type: 'script', steps: ScriptRunnerStep[] }` (see recorder.md). Replay RE-VALIDATES the persisted steps via `validateScriptSteps()` before calling `runScriptSteps()` again — a script step is never trusted just because it passed validation when it was recorded; a hand-edited or drifted `generated-tests/*.json` file gets the same rejection treatment as a fresh model output.

## Update Triggers

- When a new BrowserPort verb is added that should also be scriptable (add it to `SCRIPT_RUNNER_VERBS`/`ScriptRunnerStepSchema`/`SCRIPT_STEP_JSON_SCHEMA` AND to `executor.ts`'s switch).
- When a new dangerous pattern class needs blocking (extend `DANGEROUS_PATTERNS`/`DANGEROUS_KEYS` in validator.ts).
- When `SCRIPT_MAX_STEPS`/`SCRIPT_MAX_WALL_MS` change (also touches the navigator prompt text in planner-prompt.ts).
- When replay's re-validation behavior changes.

## Related Docs

- docs/modules/recorder.md - how a `script` ScriptStep is persisted and re-validated on replay
- docs/modules/browser-port.md - the BrowserPort verbs the script runner dispatches to
- docs/architecture/data-flow.md - where `script` sits in the per-step action-cache/read-only-guard pipeline
