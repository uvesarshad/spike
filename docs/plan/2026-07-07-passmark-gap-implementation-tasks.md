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
