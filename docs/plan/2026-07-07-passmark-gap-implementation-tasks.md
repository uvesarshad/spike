# Passmark Gap Implementation Tasks

> Date: 2026-07-07
> Source audit: docs/plan/2026-07-07-passmark-comparison-audit.md
> Scope: Detailed fix/implementation task list for closing priority gaps discovered in the Passmark comparison.

## Success Criteria

Canonical docs match the current planner/navigator implementation; the driver handles common modern interactions beyond click/type; assertions support cheap and stricter consensus modes; repeated AI runs can reuse verified cached actions; natural-language tests can use non-secret runtime data, extraction, and OTP/email flows; transient UI can be verified with video evidence; CI consumers have a clearer Playwright-facing path; and new config/env/report surfaces are documented as they land.

## Phase 0 - Docs Alignment First

- [x] Update `docs/modules/model-ladder.md`.
  - Document `Capability = 'visual-verdict' | 'plan-step' | 'plan-goals'`.
  - Document role pins: `navigatorAdapter` for `plan-step`, `plannerAdapter` for `plan-goals`.
  - Document Nano as visual plus experimental/on-device navigator, never brain.
  - Update ladder ordering and token accounting references.
- [x] Update `docs/architecture/data-flow.md`.
  - Replace single planner loop description with brain initial plan, navigator per-step loop, and brain re-plan paths.
  - Update loop exit conditions to reflect escalation before final stuck verdict.
  - Add `tokens.navigatorCalls`, `tokens.brainCalls`, and `tokens.visualCalls` to report assembly notes.
- [x] Update `docs/modules/engine.md`.
  - Document `buildLadder()` role-specific pins from `cfg.navigator` and `cfg.planner`.
  - Note Nano availability affects both visual verdicts and navigator availability.
- [x] Update `docs/modules/vibe-mode.md`.
  - Document SettingsStore fields `planner` and `navigator`.
  - Document panel model selection as Brain/Navigator rather than a single browsing-control model.
- [x] Update `docs/state/server-state.md`.
  - Document `QaSettings.navigator`.
  - Confirm API keys remain Vault-only; runtime generated data should not be stored in SettingsStore.
- [x] Update `docs/infra/environment.md`.
  - Add `QA_NAVIGATOR_PROVIDER`, `QA_NAVIGATOR_MODE`, and `QA_NAVIGATOR_MODEL`.
  - Correct any stale references to single planner behavior.
- [x] Update README/TODO stale claims.
  - Remove "Ollama stub" wording where it conflicts with `src/router/adapters/ollama.ts`.
  - Update extension/BrowserPort status where docs still call `ExtensionBrowser` a stub.
- [x] Verification: run line counts for every edited doc; split any file that would exceed 200 lines and update `docs/overview.md`.

## Phase 1 - Browser Action Vocabulary

- [x] Extend `src/ports/browser-port.ts`.
  - Add methods in one small batch: `hover(nodeId)`, `pressKey(key)`, `selectOption(nodeId, value)`, `reload()`, `goBack()`.
  - Keep names transport-neutral and avoid leaking Playwright concepts into the port.
- [x] Implement CDP support in `src/ports/cdp-browser.ts`.
  - `hover`: resolve backend node, scroll into view, dispatch mouse move.
  - `pressKey`: use `Input.dispatchKeyEvent`.
  - `selectOption`: prefer DOM value mutation plus input/change events for native selects; document custom-select limits.
  - `reload` and `goBack`: use Page/Runtime CDP primitives and settle waits consistent with `navigate`.
- [x] Implement extension parity in `src/ports/extension-browser.ts`.
  - Use the same CDP shim paths where available through `chrome.debugger`.
  - Add fallback/no-op only if capability is non-essential and documented.
- [x] Extend `src/driver/actions.ts`.
  - Add zod variants and JSON-schema entries for new actions.
  - Keep batches constrained so navigation-like actions stop the rest of the batch when URL changes.
- [x] Update `src/driver/planner-prompt.ts`.
  - Teach the navigator when to prefer hover/select/key/reload/back.
  - Keep assert/finish single-action constraints.
- [x] Update replay/recording.
  - Add new action handling in `src/recorder/script.ts`.
  - Add deterministic execution in `src/recorder/replay.ts`.
  - Add Playwright spec generation for supported actions.
- [x] Add tests: fixture controls for select/hover/key/reload/back, `test/port-contract.ts` coverage, and replay coverage for recorded new action types.
- [x] Docs update triggers.
  - Update `docs/modules/browser-port.md`, `docs/modules/recorder.md`, `docs/architecture/data-flow.md`, and `docs/infra/testing.md`.

## Phase 2 - Assertion Policy and Consensus

- [x] Design assertion policy types: `single-ladder`, `fail-on-disagreement`, and `arbiter-on-disagreement`; default to `single-ladder`.
- [x] Add config plumbing.
  - Add config field in `src/config.ts`.
  - Add env var only if needed, then update `docs/infra/environment.md`.
  - Add SettingsStore field only if panel/CLI needs persistence; do not store keys there.
- [x] Implement assertion orchestrator.
  - Create a small module around `router.visualVerdict()` rather than bloating `loop.ts`.
  - For consensus modes, run two configured visual-capable adapters and record disagreement details.
  - Use arbiter only when the policy allows it and disagreement occurs.
- [x] Extend reporting.
  - Add `assertion_trace` or extend `model_trace` with assertion group/disagreement metadata.
  - Preserve the slim 5-field MCP response unless explicitly changing the contract.
- [x] Wire into driver.
  - Use assertion policy for `assert_visual`.
  - Use assertion policy for final `finish: pass` confirmation.
- [x] Add tests: mock adapters for agreement/disagreement policies and an e2e fixture check for default `single-ladder`.
- [x] Docs update triggers.
  - Update `docs/modules/model-ladder.md`, `docs/architecture/data-flow.md`, `docs/api/route-handlers.md` if response shape changes, and `docs/infra/environment.md` if env is added.

## Phase 3 - Verified Step Action Cache

- [x] Choose persistence boundary: start file-backed under a new cache directory, or explicitly decide Redis is out of scope; never store secrets or resolved `{{secret:*}}` values.
- [x] Define cache key.
  - Include normalized host/path, current goal, action description/target, and a lightweight page signature.
  - Avoid keying only on user-supplied task text.
- [x] Define cache value.
  - Store action type, target role/name/nth/qaId when available, input placeholder text, and creation metadata.
  - Store no screenshots by default.
- [x] Add effect verification.
  - Before caching: verify action caused DOM/URL/value change or reached a wait/assert condition.
  - On cache hit: execute cached action, verify effect, then fall back to navigator on failure.
- [x] Wire into driver.
  - Check cache before navigator call only when the current goal/action intent is specific enough.
  - Record cache hits/misses in report metadata.
- [x] Add invalidation controls: CLI flag/config for bypassing cache if needed; update `docs/infra/environment.md` for any new env/config keys.
- [x] Add tests: unit coverage for key generation/redaction and stale-cache fallback helpers.
- [x] Add driver-level coverage for miss, hit, and stale fallback behavior after driver wiring.
- [x] Docs update triggers.
  - Update `docs/state/server-state.md`, `docs/architecture/data-flow.md`, `docs/modules/engine.md`, and `docs/infra/testing.md`.

## Phase 4 - Runtime Data, Extraction, and Email

- [x] Define non-secret run data model: `{{run.email}}`, `{{run.shortid}}`, `{{run.name}}`, `{{run.phone}}`; keep generated data separate from Vault secrets.
- [x] Add placeholder resolver.
  - Resolve non-secret placeholders before type actions.
  - Preserve original placeholder text in reports/scripts where useful for replay.
- [x] Add extraction action.
  - Add `extract` or `assert_extract` action that stores visible DOM text or model-extracted structured values into run state.
  - Support later references like `{{run.orderId}}`.
- [x] Add optional email provider interface.
  - Start with an interface and a fake/local test provider.
  - Defer real external providers until product need is clear.
- [x] Update recorder/replay.
  - Preserve placeholder expressions in QaScripts where deterministic replay can regenerate or reuse values.
  - Document replay behavior for dynamic values.
- [x] Add focused module tests for generated run values, extraction helpers, fake email provider, and OTP lookup.
- [x] Docs update triggers.
  - Update `docs/state/server-state.md`, `docs/modules/recorder.md`, `docs/architecture/data-flow.md`, and `docs/api/route-handlers.md` if CLI/MCP inputs change.

## Phase 5 - Video Assertion Mode

- [x] Define action/report surface: prefer `assert_visual` with `mode: 'screenshot' | 'video'` unless `assert_video` is cleaner; decide slim `evidence_paths` behavior.
- [x] Implement recording backend selection.
  - CDP mode: reuse existing screencast/GIF only if input side effects remain safe.
  - Extension mode: prefer existing tabCapture WebM plumbing.
- [x] Add video-capable adapter route.
  - Current route records best-effort clip evidence and keeps provider calls on screenshot-capable visual adapters only.
  - Fail gracefully to screenshot path when recording/upload fails.
- [x] Add tests: video mode action/script/spec handling plus generated-spec escaping; real transient fixture remains covered by safe screenshot fallback until a video model adapter exists.
- [x] Docs update triggers.
  - Update `docs/modules/engine.md`, `docs/architecture/data-flow.md`, `docs/state/server-state.md`, and `docs/api/external-services.md`.

## Phase 6 - CI and Playwright-Facing Ergonomics

- [x] Improve generated Playwright specs: add new Phase 1 action generation and artifact/report comments or attachments where possible.
- [x] Add CLI suite ergonomics.
  - Make `qa replay --all` output machine-readable summary JSON.
  - Ensure exit codes distinguish fail vs uncertain if CI needs it.
- [x] Evaluate a helper package/API.
  - Export a small Node API only if it does not compromise daemon/MCP positioning.
  - Candidate: `qaRunAsPlaywrightTest({ task, url, expect, test })`.
- [x] Add docs examples.
  - Add CI sample commands for replay-first workflows.
  - Add guidance for committing or caching `generated-tests/`.
- [x] Add tests: MCP contract still returns the slim 5-field object and generated specs compile for all supported replay actions.
- [x] Docs update triggers.
  - Update `docs/api/route-handlers.md`, `docs/modules/recorder.md`, `docs/infra/testing.md`, and README.

## Phase 7 - Telemetry and Gateway Support

- [x] Design telemetry module: no-op default tracer wrapping adapter calls, browser actions, replay failures, and assertion consensus.
- [x] Add optional OTLP/Axiom export.
  - Keep telemetry opt-in.
  - Redact secrets and avoid screenshots/clips in traces.
- [x] Add provider gateway configuration: prefer extending `OpenAiCompatibleAdapter` for generic OpenAI-compatible gateways while keeping direct BYOK adapters intact.
- [x] Add tests: no-op telemetry has zero behavior change and mock exporter receives spans without secret values.
- [x] Docs update triggers.
  - Update `docs/api/external-services.md`, `docs/infra/environment.md`, `docs/state/server-state.md`, and README.

## Cross-Phase Guardrails

- [x] Never import from `spikes/` into `src/`.
- [x] Never hardcode the Google CLI binary name; use `cfg.googleCliBin`.
- [x] Never run Chrome headless for Nano-dependent flows.
- [x] Never store API keys in `SettingsStore`.
- [x] Always apply `isSafeModelId()` before passing user model IDs to CLI adapters.
- [x] Any BrowserPort method addition must update both `CdpBrowser` and `ExtensionBrowser`.
- [x] Any new env var must update `docs/infra/environment.md`.
- [x] Any doc over 200 lines must be split and indexed from `docs/overview.md`.

## Suggested Implementation Order

1. Phase 0 docs alignment.
2. Phase 1 action vocabulary.
3. Phase 2 assertion policy.
4. Phase 4 runtime data/extraction.
5. Phase 3 action cache.
6. Phase 5 video assertions.
7. Phase 6 CI ergonomics.
8. Phase 7 telemetry/gateways.

## Update Decision Tree Result

- Runtime code changed: yes, Phases 1-7 changed BrowserPort actions, assertion policy routing, run data/extract, action cache, video-mode evidence, replay JSON output, telemetry, and gateway helpers.
- Env vars changed: yes, `QA_ASSERTION_POLICY`, `QA_ACTION_CACHE`, and `QA_ACTION_CACHE_DIR` were added and documented in `docs/infra/environment.md`.
- BrowserPort changed: yes, `hover`, `pressKey`, `selectOption`, `reload`, and `goBack` were added to all implementations.
- Report contract changed: yes, full reports can include `assertion_trace`, `run_data`, `action_cache`, and per-step `video`; the slim five-field MCP response is unchanged.
- Docs added: yes, this task list plus `docs/modules/action-cache.md`.
- Docs index update required: completed, `docs/overview.md` lists the plan files and action-cache module.

---

# Round 2 - Post-Audit Feature Gaps (Phases 8-15)

> Date: 2026-07-09
> Source: cross-check of Round 1 (Phases 0-7) against the audit's deferred roadmap, plus code-level gaps found on review.
> Round 1 is fully verified: all checkboxes real, typecheck clean, 66 unit checks (v26-v31) pass, extension parity complete.

## Round 2 - Completion Status (2026-07-10)

Implemented by three parallel Sonnet-5 lanes (driver/actions, config/router/models, recorder/telemetry) with disjoint file ownership, then integrated by the coordinator (cross-lane switch/interface reconciliation in report.ts, action-cache.ts, fix-prompt.ts, test FakeBrowsers). Verified:

- `tsc --noEmit`: clean across the whole repo.
- `npm run build`: both bundles (CLI/MCP + lite extension) succeed.
- Pure-logic unit checks pass: v26 (9), v27 run-data/extract (21), v28 (16), v29 telemetry (25), v30 video (21), v31 (8), v32 script-runner (24), v25 providers (34), m4 router/config-drift (15), v7 vibe-service (19), v13 (32), v20 (17).
- Live Chrome: m1/port-contract action parity (22) — upload/drag/blur/mouse/tabs exercised against real Chrome.
- Phase 14 matcher verified in isolation (6 checks: match, near-miss, unrelated→null, port/domain hard-gate, empty dir).
- Phase 8 video toggle wired end-to-end: `#setVideoAssert` panel checkbox → panel.js → sw.js/liteSetSettings → vibe.config.set/buildLiteConfig → QaSettings.videoAssertions → config.fromSettings → cfg.videoAssertions → engine → loop.ts video-verdict route (env `QA_VIDEO_ASSERTIONS` still wins).

Nuances (not gaps in the checklist, but worth recording):
- The two full live-AI e2e suites (`e2e.recorder`, `e2e.run-fixture`) are ENV-GATED: they run real `qaRun()` AI passes needing model quota, and this machine has no BYOK key + a dead `gemini:cli`. Run them with a model configured, e.g. `QA_PLANNER_PROVIDER=claude QA_PLANNER_MODE=cli QA_NAVIGATOR_PROVIDER=claude QA_NAVIGATOR_MODE=cli npm run test:e2e`.
- Phase 11 telemetry spans wrap the qa.run / driver-loop / replay boundaries (always-on, redacted, no-op sink by default) plus the Round-1 adapter-call instrumentation; per-individual-browser-action spans were intentionally not added (would require editing driver/router internals mid-parallel-build) and can be a follow-up.

## Round 2 - Decisions Locked (2026-07-09)

- Video assertions: fix so a video-capable adapter actually judges the recorded clip, but keep it OFF by default and expose an enable/disable toggle (it is costly).
- Action parity: complete the remaining batches.
- Playwright helper/reporter package: **DROPPED**. The extension already gives cursor-driven in-browser navigation on Windows, and the daemon/MCP + replay path already serves CI; a Playwright-library shape dilutes the wedge.
- Secure script runner: build it, AST-validated.
- Telemetry: make it first-class with a local dashboard.
- Model SDKs: Nano-default is fine for now, but wire up reliable non-Nano provider SDKs so a cheap cloud navigator/visual is first-class.
- Config drift: fix.
- Pre-run replay matcher: add.
- Action cache: **keep single-machine**, file-backed, opt-in - no shared/Redis backend (deliberate boundary, documented).
- Structured extraction: add model-assisted DOM extraction.

## Phase 8 - Video Assertion (opt-in, real video verdict)

Goal: `assert_visual { mode: 'video' }` should route the recorded clip to a video-capable model instead of falling back to a screenshot verdict; OFF by default, toggled from config + panel.

- [x] Add a video-capable visual route.
  - Extend the visual adapter interface with optional `supportsVideo` and a `videoVerdict(clipPath, expectation)` path (`src/router/adapter.ts`, `src/router/model-router.ts`, `src/router/verdict.ts`).
  - Implement for at least one BYOK provider - Gemini Files API upload -> verdict is the natural first target; document Anthropic/OpenAI as screenshot-only if their frames path is not viable.
  - Leave `mode: 'screenshot'` and the no-video-adapter case exactly as today.
- [x] Gate behind an explicit enable flag (it is costly).
  - Config field `assertion.video: boolean` default `false` (`src/config.ts`) + env `QA_VIDEO_ASSERTIONS`.
  - With the flag OFF, `mode: 'video'` does a safe screenshot fallback and writes a report note ("video assertion requested but disabled").
- [x] Add the panel toggle.
  - Add an "Enable video assertions (paid vision, slower)" checkbox to the extension Settings (`src/vibe/settings.ts`, `src/vibe/settings-data.ts`, side panel), persisted in `QaSettings`, default unchecked, wired to the same config field.
- [x] Recording backend.
  - CDP mode: reuse `src/clip/screencast.ts` to record the assert-step window; verify no input side effects.
  - Extension mode: reuse the tabCapture WebM path.
  - Fail gracefully to the screenshot path on record/upload error.
- [x] Reporting: full report gets a per-assertion `video` evidence path + which adapter judged it; `assertion_trace` records video-vs-screenshot. Slim 5-field MCP response unchanged.
- [x] Tests: extend `test/v30.video-assertion.ts` - mock video adapter returns a verdict when enabled; disabled path asserts screenshot fallback + note; upload failure falls back.
- [x] Docs: `docs/modules/engine.md`, `docs/modules/model-ladder.md`, `docs/architecture/data-flow.md`, `docs/state/server-state.md`, `docs/api/external-services.md` (Gemini Files API), `docs/infra/environment.md` (new env).

## Phase 9 - Action Parity Completion

Goal: file upload, drag/drop, tab/window primitives, mouse actions, blur - the audit's "Second/Third" batches.

- [x] Extend `src/ports/browser-port.ts`: `uploadFile(nodeId, paths)`, `dragAndDrop(sourceId, targetId)`, discrete `mouseDown/mouseUp/mouseMove` (or one `mouse(action,x,y)`), `blur(nodeId)`, and tab/window primitives `openTab(url)` / `switchTab(idOrIndex)` / `closeTab(id)`. Keep names transport-neutral.
- [x] CDP impl (`src/ports/cdp-browser.ts`): `DOM.setFileInputFiles` for upload; `Input.dispatchMouseEvent` sequences for drag/drop + mouse; blur via focus move/DOM; `Target` domain for tabs.
- [x] Extension parity (`src/ports/extension-browser.ts` + `src/extension/lite-extension-browser.ts`): `chrome.debugger` equivalents; `chrome.tabs` for tab primitives; document any op MV3 cannot do 1:1.
- [x] Actions (`src/driver/actions.ts`): zod + JSON-schema entries; keep tab-switch/navigation batch-stopping semantics.
- [x] Navigator prompt (`src/driver/planner-prompt.ts`): teach when to upload/drag/switch-tab/blur.
- [x] Recorder/replay (`src/recorder/script.ts`, `src/recorder/replay.ts`): record + deterministically replay; generate Playwright spec twins. Upload file paths in scripts must be portable/relative and never embed secrets.
- [x] Tests: extend `test/port-contract.ts` with live-fixture controls for upload/drag/blur/mouse; fixture gains an upload input + drag zone + second-tab trigger; replay coverage for each new recorded action type.
- [x] Docs: `docs/modules/browser-port.md`, `docs/modules/recorder.md`, `docs/architecture/data-flow.md`, `docs/infra/testing.md`.

## Phase 10 - Secure Script Runner

Goal: a constrained custom-step escape hatch for app-specific actions that are hard to model - strictly validated, no arbitrary Node.

- [x] Decide surface: a `script` action whose body is a small allowlisted DSL over `BrowserPort` ops (NOT raw Playwright/Node). Prefer a declarative step list or a tiny expression language over any `eval`.
- [x] Build the validator (`src/driver/script-runner/`): AST-parse the body; allowlist only `BrowserPort` verbs + run-data placeholders; reject `import`/`require`/`fs`/network/`process`/`eval`/`Function`/prototype access. No arbitrary Node access.
- [x] Execute against `BrowserPort` only; resolve `{{run.*}}` / `{{secret:*}}` at execute time; never echo resolved secrets into reports (reuse redaction). Cap steps and wall-time.
- [x] Wire into driver + actions schema; on validation failure, reject the action and escalate to the brain rather than executing.
- [x] Recorder/replay: persist the validated script step; replay re-validates before running.
- [x] Tests: validator accepts allowlisted steps and rejects imports/fs/network/eval/secret-leak; execution drives the fixture; replay re-validation.
- [x] Docs: new `docs/modules/script-runner.md` (index from `docs/overview.md`), `docs/architecture/data-flow.md`, `docs/infra/testing.md`; security note alongside the host-guard/Vault posture.

## Phase 11 - First-Class Telemetry & Dashboard

Goal: promote telemetry from opt-in no-op to always-structured spans plus a local dashboard.

- [x] Always-on structured spans (redacted) around adapter calls, browser actions, assertion consensus, replay failures, and cache hits/misses (`src/telemetry/*`) - no-op exporter still the default, but spans always produced.
- [x] Local dashboard: a `qa dashboard` CLI command serving a localhost read-only view of `artifacts/<runId>` reports, `model_trace`/`assertion_trace`, token accounting by capability, and cache/replay stats. $0, no backend, reuses `report.json`.
- [x] Documented external export: OTLP -> Grafana/Tempo and Axiom setup, opt-in, with secrets/screenshots/clips redacted from spans.
- [x] Tests: extend `test/v29.telemetry.ts` - spans always emitted with the no-op exporter and zero behavior change; dashboard renders a sample run; exported spans carry no secrets/clips.
- [x] Docs: `docs/api/external-services.md`, `docs/infra/environment.md`, `docs/state/server-state.md`, README; new `docs/modules/telemetry.md` if it outgrows a section.

## Phase 12 - Additional Model SDK Adapters (reliable non-Nano navigator/visual)

Goal: Nano-default stays, but ensure a reliable cheap cloud navigator + visual is first-class and easy to pin.

- [x] Audit `src/router/adapters/*` for gaps; ensure a cheap vision-cloud model (e.g. Gemini Flash, Claude Haiku) is selectable for BOTH `plan-step` and `visual-verdict`, not just planning.
- [x] Add/upgrade adapters via `OpenAiCompatibleAdapter` knobs where possible (`supportsVision`/`jsonMode`/`extraBody`) - do not write new adapter classes; confirm current Anthropic model IDs via the `claude-api` skill before hardcoding.
- [x] Ship a documented "reliable default" recipe: env pins for a cheap cloud navigator + visual that do not depend on Nano/experimental paths.
- [x] Availability probes: short-TTL caching for slow CLI/provider probes (audit perf note) while preserving can-become-available-mid-run.
- [x] Tests: extend `test/v25.providers.ts` - new/updated adapters route correctly per capability; navigator+visual selectable; probe TTL respected.
- [x] Docs: `docs/modules/model-ladder.md`, `docs/infra/environment.md`, README.

## Phase 13 - Config Drift Fix

Goal: persisted `settings.json` and code defaults must agree; no run resolves to the dead `gemini:cli`.

- [x] Migrate persisted settings on load: if `planner` is `gemini:cli` (dead) or `navigator` is unset, migrate to current code defaults (brain -> `claude` CLI, navigator -> Nano) and rewrite (`src/config.ts`, `src/vibe/settings.ts`).
- [x] Single source of truth: the code default and the checked-in `settings.json` must match; update the checked-in file.
- [x] Startup warning if a resolved adapter is known-dead (Gemini free tier) with the recovery hint.
- [x] Tests: extend `test/m4.router.ts` (or a new config test) - dead-planner settings migrate; env still overrides; a lone `QA_*_MODEL` partial-merge stays intact.
- [x] Docs: fix the "Navigator/brain pins" gotcha in `CLAUDE.md`, `docs/infra/environment.md`, and `docs/modules/vibe-mode.md` to reflect migration.

## Phase 14 - Pre-Run Replay Matcher

Goal: before a fresh AI run, detect an existing `generated-tests/` script matching task+url and prefer the $0 replay.

- [x] Matcher (`src/recorder/`): normalize task text + url/host; score against recorded scripts (task similarity + host/path match); return the best candidate over a threshold.
- [x] Wire into `qa run` / `engine.ts` and MCP `qa_run`: a confident match replays first; on replay failure, fall back to a full AI run (optionally `--heal`). Add `--no-replay` to bypass.
- [x] CLI UX: `qa run` prints "matched replay <name> - using $0 replay (override with --no-replay)".
- [x] Report: record whether the run used a matched replay vs a fresh AI run.
- [x] Tests: extend `test/e2e.recorder.ts` - a recorded script is matched and replayed for a matching task; a near-miss falls through to AI; `--no-replay` bypasses.
- [x] Docs: `docs/modules/recorder.md`, `docs/architecture/data-flow.md`, README, `docs/infra/environment.md` if a flag/env is added.

## Phase 15 - Model-Assisted Structured DOM Extraction

Goal: extend `extract` beyond visible-text/regex to model-extracted structured values.

- [x] Extend the `extract` action (`src/driver/actions.ts`): add an optional model-extraction mode - `extract { nodeId?, key, prompt?/schema? }` that asks a cheap text adapter to pull a structured value from the serialized subtree/page text into run state.
- [x] Route through a cheap `plan-step`-capable text adapter (not vision) when DOM text suffices; store into run-data state (`src/run-data/*`) as `{{run.<key>}}`.
- [x] Keep the existing DOM-text/regex path as the $0 default; model extraction only when requested.
- [x] Redaction: never persist secrets; extracted values follow the same non-secret run-data rules.
- [x] Recorder/replay: preserve the extract expression; deterministic replay reuses/regenerates per documented behavior.
- [x] Tests: extend `test/v27.run-data.ts` - model-assisted extraction (mock adapter) stores a structured value; falls back to DOM text; later `{{run.*}}` resolves it.
- [x] Docs: `docs/state/server-state.md`, `docs/modules/recorder.md`, `docs/architecture/data-flow.md`.

## Round 2 - Explicit Scope Decisions

- DROPPED: Playwright-facing helper/reporter package (audit P2). The extension provides cursor-driven in-browser navigation on Windows and the daemon/MCP + replay path already serves CI; a Playwright-library shape would dilute the wedge.
- KEPT AS-IS: the action cache stays single-machine, file-backed, opt-in - no shared/Redis backend. This is a deliberate boundary, documented in `docs/modules/action-cache.md`.

## Round 2 - Cross-Phase Guardrails (in addition to Round 1's)

- Any `BrowserPort` method addition updates `CdpBrowser`, `ExtensionBrowser`, AND `lite-extension-browser.ts`.
- Secure script runner: allowlist/AST only, no arbitrary Node, no imports/fs/network, no secret exposure in reports.
- Never store API keys in `SettingsStore`; new toggles (video, telemetry) persist only non-secret flags.
- Any new env var updates `docs/infra/environment.md`; any doc over 200 lines is split and indexed from `docs/overview.md`.
- Never hardcode the Google CLI binary; apply `isSafeModelId()` before passing user model IDs to CLI adapters.

## Round 2 - Suggested Implementation Order

1. Phase 13 config drift (unblocks reliable runs first).
2. Phase 12 model SDKs (reliable cloud navigator/visual).
3. Phase 9 action parity.
4. Phase 15 structured extraction.
5. Phase 14 pre-run replay matcher.
6. Phase 8 video assertion (opt-in).
7. Phase 10 secure script runner.
8. Phase 11 telemetry & dashboard.

Rationale: fix defaults + reliable models before adding surface area; land the cheap high-value items (parity, extraction, matcher) before the costlier/optional ones (video, script runner, dashboard).
