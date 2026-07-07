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

- [ ] Design assertion policy types: `single-ladder`, `fail-on-disagreement`, and `arbiter-on-disagreement`; default to `single-ladder`.
- [ ] Add config plumbing.
  - Add config field in `src/config.ts`.
  - Add env var only if needed, then update `docs/infra/environment.md`.
  - Add SettingsStore field only if panel/CLI needs persistence; do not store keys there.
- [ ] Implement assertion orchestrator.
  - Create a small module around `router.visualVerdict()` rather than bloating `loop.ts`.
  - For consensus modes, run two configured visual-capable adapters and record disagreement details.
  - Use arbiter only when the policy allows it and disagreement occurs.
- [ ] Extend reporting.
  - Add `assertion_trace` or extend `model_trace` with assertion group/disagreement metadata.
  - Preserve the slim 5-field MCP response unless explicitly changing the contract.
- [ ] Wire into driver.
  - Use assertion policy for `assert_visual`.
  - Use assertion policy for final `finish: pass` confirmation.
- [ ] Add tests: mock adapters for agreement/disagreement policies and an e2e fixture check for default `single-ladder`.
- [ ] Docs update triggers.
  - Update `docs/modules/model-ladder.md`, `docs/architecture/data-flow.md`, `docs/api/route-handlers.md` if response shape changes, and `docs/infra/environment.md` if env is added.

## Phase 3 - Verified Step Action Cache

- [ ] Choose persistence boundary: start file-backed under a new cache directory, or explicitly decide Redis is out of scope; never store secrets or resolved `{{secret:*}}` values.
- [ ] Define cache key.
  - Include normalized host/path, current goal, action description/target, and a lightweight page signature.
  - Avoid keying only on user-supplied task text.
- [ ] Define cache value.
  - Store action type, target role/name/nth/qaId when available, input placeholder text, and creation metadata.
  - Store no screenshots by default.
- [ ] Add effect verification.
  - Before caching: verify action caused DOM/URL/value change or reached a wait/assert condition.
  - On cache hit: execute cached action, verify effect, then fall back to navigator on failure.
- [ ] Wire into driver.
  - Check cache before navigator call only when the current goal/action intent is specific enough.
  - Record cache hits/misses in report metadata.
- [ ] Add invalidation controls: CLI flag/config for bypassing cache if needed; update `docs/infra/environment.md` for any new env/config keys.
- [ ] Add tests: unit coverage for key generation/redaction and fixture e2e for miss, hit, stale-cache fallback.
- [ ] Docs update triggers.
  - Update `docs/state/server-state.md`, `docs/architecture/data-flow.md`, `docs/modules/engine.md`, and `docs/infra/testing.md`.

## Phase 4 - Runtime Data, Extraction, and Email

- [ ] Define non-secret run data model: `{{run.email}}`, `{{run.shortid}}`, `{{run.name}}`, `{{run.phone}}`; keep generated data separate from Vault secrets.
- [ ] Add placeholder resolver.
  - Resolve non-secret placeholders before type actions.
  - Preserve original placeholder text in reports/scripts where useful for replay.
- [ ] Add extraction action.
  - Add `extract` or `assert_extract` action that stores visible DOM text or model-extracted structured values into run state.
  - Support later references like `{{run.orderId}}`.
- [ ] Add optional email provider interface.
  - Start with an interface and a fake/local test provider.
  - Defer real external providers until product need is clear.
- [ ] Update recorder/replay.
  - Preserve placeholder expressions in QaScripts where deterministic replay can regenerate or reuse values.
  - Document replay behavior for dynamic values.
- [ ] Add tests: fixture signup/OTP-like page with fake email provider and replay coverage for extracted values.
- [ ] Docs update triggers.
  - Update `docs/state/server-state.md`, `docs/modules/recorder.md`, `docs/architecture/data-flow.md`, and `docs/api/route-handlers.md` if CLI/MCP inputs change.

## Phase 5 - Video Assertion Mode

- [ ] Define action/report surface: prefer `assert_visual` with `mode: 'screenshot' | 'video'` unless `assert_video` is cleaner; decide slim `evidence_paths` behavior.
- [ ] Implement recording backend selection.
  - CDP mode: reuse existing screencast/GIF only if input side effects remain safe.
  - Extension mode: prefer existing tabCapture WebM plumbing.
- [ ] Add video-capable adapter route.
  - Use provider capability checks; do not send video to adapters that cannot consume it.
  - Fail gracefully to screenshot path when recording/upload fails.
- [ ] Add tests: transient toast/snackbar fixture proving video mode captures evidence that screenshot mode can miss.
- [ ] Docs update triggers.
  - Update `docs/modules/engine.md`, `docs/architecture/data-flow.md`, `docs/state/server-state.md`, and `docs/api/external-services.md`.

## Phase 6 - CI and Playwright-Facing Ergonomics

- [ ] Improve generated Playwright specs: add new Phase 1 action generation and artifact/report comments or attachments where possible.
- [ ] Add CLI suite ergonomics.
  - Make `qa replay --all` output machine-readable summary JSON.
  - Ensure exit codes distinguish fail vs uncertain if CI needs it.
- [ ] Evaluate a helper package/API.
  - Export a small Node API only if it does not compromise daemon/MCP positioning.
  - Candidate: `qaRunAsPlaywrightTest({ task, url, expect, test })`.
- [ ] Add docs examples.
  - Add CI sample commands for replay-first workflows.
  - Add guidance for committing or caching `generated-tests/`.
- [ ] Add tests: MCP contract still returns the slim 5-field object and generated specs compile for all supported replay actions.
- [ ] Docs update triggers.
  - Update `docs/api/route-handlers.md`, `docs/modules/recorder.md`, `docs/infra/testing.md`, and README.

## Phase 7 - Telemetry and Gateway Support

- [ ] Design telemetry module: no-op default tracer wrapping adapter calls, browser actions, replay failures, and assertion consensus.
- [ ] Add optional OTLP/Axiom export.
  - Keep telemetry opt-in.
  - Redact secrets and avoid screenshots/clips in traces.
- [ ] Add provider gateway configuration: prefer extending `OpenAiCompatibleAdapter` for generic OpenAI-compatible gateways while keeping direct BYOK adapters intact.
- [ ] Add tests: no-op telemetry has zero behavior change and mock exporter receives spans without secret values.
- [ ] Docs update triggers.
  - Update `docs/api/external-services.md`, `docs/infra/environment.md`, `docs/state/server-state.md`, and README.

## Cross-Phase Guardrails

- [ ] Never import from `spikes/` into `src/`.
- [ ] Never hardcode the Google CLI binary name; use `cfg.googleCliBin`.
- [ ] Never run Chrome headless for Nano-dependent flows.
- [ ] Never store API keys in `SettingsStore`.
- [ ] Always apply `isSafeModelId()` before passing user model IDs to CLI adapters.
- [ ] Any BrowserPort method addition must update both `CdpBrowser` and `ExtensionBrowser`.
- [ ] Any new env var must update `docs/infra/environment.md`.
- [ ] Any doc over 200 lines must be split and indexed from `docs/overview.md`.

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

- Runtime code changed: yes, Phase 1 BrowserPort/action vocabulary changed.
- Env vars changed: no.
- BrowserPort changed: yes, `hover`, `pressKey`, `selectOption`, `reload`, and `goBack` were added.
- Report contract changed: no.
- Docs added: yes, this task list.
- Docs index update required: completed, `docs/overview.md` lists this file.
