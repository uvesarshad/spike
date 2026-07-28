# Passmark Comparison Audit

> Date: 2026-07-07
> Scope: Compare this project against `bug0inc/passmark`, then identify gaps, feature enhancements, and performance opportunities.
> Sources checked: local docs/code in this repo; Passmark GitHub README and source files at https://github.com/bug0inc/passmark.

## Executive Summary

Passmark and spike-agent solve adjacent but different jobs.

Passmark is a Playwright library for teams already writing Playwright tests. It embeds AI inside `@playwright/test` via `runSteps()`, `runUserFlow()`, and `assert()`, then optimizes repeated test runs with Redis step caching, auto-healing, multi-model assertion consensus, dynamic data, extraction, video assertions, gateway support, and telemetry.

spike-agent is an out-of-process QA daemon for coding agents and vibe-mode users. It owns Chrome through CDP or an MV3 extension, uses a cost-ordered model ladder with Gemini Nano first, returns a slim evidence-backed verdict over CLI/MCP, records passing runs into deterministic replay scripts, and can generate or apply fix prompts.

The local project has a stronger agent-integration story and a more opinionated low-cost architecture. Passmark has a stronger test-authoring library surface and a broader action/data/assertion feature set. The biggest local gaps are not basic browser control; they are productized test-suite ergonomics: reusable flow API, assertion consensus policy, step/action caching, data extraction/placeholders, richer Playwright parity, provider/gateway observability, and docs that reflect the already-shipped planner/navigator split.

## Passmark Baseline

Observed from the public repo:

- Package form: npm library named `passmark`, peer-dependent on `@playwright/test` and `playwright-core`.
- Primary API: `runSteps(options)`, `runUserFlow(options)`, and `assert(options)`.
- Execution model: AI tool-calling against a Playwright `Page`; by default it uses ARIA accessibility snapshots, with an optional OpenAI CUA screenshot-driven mode.
- Step caching: Redis stores successful single-step actions keyed by user flow and step description; cached steps are verified and auto-healed on failure.
- Assertions: Claude plus Gemini consensus, with configurable arbiter behavior on disagreement.
- Video assertions: optional per-assertion recording, uploaded to Gemini Files API for transient UI checks.
- Data and state: runtime placeholders such as `{{run.*}}`, `{{global.*}}`, `{{data.*}}`, and `{{email.*}}`; Redis-backed shared/project data; pluggable email extraction.
- Action breadth: click, type, select, hover, drag/drop, key press, file upload, navigation, screenshots, waits, mouse actions, blur, and generated unique values.
- Safety: AST-validated secure script runner for constrained Playwright script steps.
- Observability: Pino logging plus optional Axiom/OpenTelemetry tracing.
- Provider surface: direct providers and gateways including Vercel AI Gateway, OpenRouter, OpenCode Zen, and Cloudflare AI Gateway.

## Local Baseline

Observed from local docs and code:

- Package form: CLI/MCP daemon plus Chrome MV3 extension, not a Playwright library.
- Primary API: `spike run`, `spike replay`, `spike daemon`, MCP `qa_run`, extension side panel, and auto-fix commands.
- Browser abstraction: `BrowserPort` with CDP and extension implementations; both use a real headed Chrome.
- Model architecture: `ModelRouter` supports `visual-verdict`, `plan-step` navigator, and `plan-goals` brain roles. Nano is rung 0 and now supports visual verdicts plus navigator steps; cloud/CLI/BYOK/Ollama adapters provide fallbacks.
- Driver loop: accessibility-tree-first, 1-3 action batches, per-step console/network evidence, host mutation guard, secret redaction, retry by role/name, pass confirmation by visual verdict, brain re-plan on stuck states.
- Recording: passing runs emit `generated-tests/*.json` and Playwright `.spec.ts` twins; replay is deterministic and can self-heal by re-running the AI driver.
- Vibe mode: side panel, bridge multiplexing, ghost cursor overlay, clip plumbing, cancel, run history, fix prompt, and auto-fix loop.
- Security posture: Vault for API keys/secrets, Windows DPAPI key backend, `{{secret:*}}` execute-time resolution, default localhost-only mutation guard, audit log.
- Performance posture: slim report returned to the expensive caller, Nano-first visual path, navigator/brain split, token accounting by capability, warm Chrome/Nano profile.

## Side-by-Side Comparison

| Area | Passmark | spike-agent | Audit take |
|---|---|---|---|
| Integration shape | Playwright library in test files | CLI/MCP daemon and extension | Local is better for coding-agent delegation; Passmark is better for normal test suites. |
| Browser runtime | Playwright-managed page | Headed Chrome via CDP or extension bridge | Local gains real-user-session/vibe control; Passmark gains mature Playwright primitives. |
| Page representation | Playwright ARIA snapshots; optional CUA screenshots | Chrome accessibility tree; screenshots only when needed | Both are a11y-first. Local should borrow Passmark's richer action vocabulary. |
| Cost model | Paid/provider model calls, reduced by Redis caching | Cheap ladder, Nano-first, slim verdict, deterministic replay | Local has stronger cost thesis; Passmark has stronger repeated-step caching. |
| Assertions | Multi-model consensus, arbiter, video assertions | Single visual ladder verdict plus DOM asserts | Consensus policy and video assertions are major local gaps. |
| Reuse | Redis cached locator actions; reusable test code by Playwright | Recorded JSON replay plus generated Playwright twin | Local replay is stronger for zero-token reruns; Passmark caching is stronger for partial reuse inside AI runs. |
| Data-driven tests | Placeholders, global/project data, email extraction | Secrets placeholders only; no general data/extraction DSL | Local lacks first-class data/extract/email flows. |
| Safety | Secure script runner for constrained Playwright snippets | Host guard, Vault, audit, CLI model-id sanitization | Both have useful safety. Local should avoid adding arbitrary script execution without a strict validator. |
| Observability | Pino, Axiom, OpenTelemetry | JSON reports, model trace, audit log, artifacts | Local has strong artifact evidence but weak external telemetry. |
| CI | Native Playwright test integration | Best-effort generated Playwright specs plus replay command | Local needs a stronger CI/package story if competing with test frameworks. |

## Gap Findings

### P0 - Documentation Drift

Some core docs still describe the pre-split planner architecture. For example, `docs/modules/model-ladder.md`, `docs/architecture/data-flow.md`, `docs/modules/vibe-mode.md`, and `docs/state/server-state.md` understate the current navigator/brain split and `QaSettings.navigator`. The code and `docs/plan/2026-07-01-planner-navigator-split-todo.md` show the split is shipped.

Impact: future agents may make wrong changes, especially around model selection, defaults, and performance claims.

Recommendation: update the affected module docs so `plan-step`/`plan-goals`, `navigator`, Nano navigator behavior, and role-specific token accounting are first-class in the canonical docs.

### P1 - No Assertion Consensus Layer

Passmark treats assertions as a dedicated multi-model consensus problem: primary, secondary, and optional arbiter. Local visual verdicts escalate on uncertainty/failure through the ladder, but there is no explicit disagreement policy, confidence score, or consensus surface.

Impact: visual and semantic assertions may be over-trusted when one model gives a confident but wrong answer.

Recommendation: add an `assertionPolicy` layer for `assert_visual` and final pass confirmation:

- `single-ladder` default for cost-sensitive runs.
- `fail-on-disagreement` for regression suites.
- `arbiter-on-disagreement` for higher-confidence checks.
- Record each model's reasoning in `model_trace` or a new `assertion_trace`.

### P1 - No Step-Level Action Cache During AI Runs

Local deterministic replay is excellent after a pass, but during exploratory AI runs the driver still replans and re-executes similar steps. Passmark caches successful single-step locators in Redis and verifies cached action effects before falling back to AI.

Impact: repeated flows across tasks still burn navigator calls until a full replay script exists.

Recommendation: add an optional action cache keyed by normalized task/goal/action intent plus page URL/signature. Keep it separate from replay scripts. Use the existing `BrowserPort` target records and effect verification to auto-heal when stale.

### P1 - Data, Extraction, and Email Flows Are Thin

Passmark supports runtime placeholders, project/global values, generated values, AI extraction, and email-provider extraction. Local only has secure `{{secret:*}}` substitution and task text.

Impact: signup, OTP, invitation, account provisioning, and data-driven checkout tests are hard to express repeatably.

Recommendation: add a small data DSL before adding broad scripting:

- `{{run.email}}`, `{{run.shortid}}`, `{{run.name}}`.
- `extract` action or assertion that stores visible/page-derived values into run state.
- Optional email provider interface for OTP extraction.
- Keep secrets in Vault and non-secret run data in artifacts or a small state store.

### P1 - Action Vocabulary Is Narrow

Local action schema supports navigate, click, type, assert_visual, assert_dom, wait, and finish. Passmark includes hover, select dropdown, drag/drop, keyboard, file upload, back/forward/reload, mouse actions, blur, and screenshot capture.

Impact: real web apps with menus, custom selects, uploads, keyboard shortcuts, drag interactions, and multitab flows require awkward model workarounds.

Recommendation: extend `BrowserPort` and both implementations in small batches:

- First: `selectOption`, `pressKey`, `hover`, `reload`, `goBack`.
- Second: file upload and drag/drop, with extension parity checks.
- Third: tab/window primitives if product needs them outside vibe mode.

### P1 - Video Assertions Are Not Productized

Local has GIF/WebM clip recording plumbing, but visual verdicts judge screenshots. Passmark uses video assertions for transient UI such as toasts.

Impact: short-lived state can be missed by the final screenshot or per-step screenshot.

Recommendation: introduce `assert_video` or `assert_visual { mode: "video" }` that records the step window and routes to a video-capable provider when available. In extension mode, base this on the tabCapture WebM path rather than CDP screencast.

### P2 - CI/Test Library Ergonomics Lag Passmark

Passmark is installed into an existing Playwright project and its reports land inside Playwright's report flow. Local emits best-effort `.spec.ts` twins, but the primary workflow is daemon-driven.

Impact: test teams may not adopt the tool as a normal regression-suite dependency even if the agent workflow works well.

Recommendation: add a lightweight npm helper package or exported test fixture:

- `qaRunAsPlaywrightTest({ task, url })`.
- `qaReplayAll()` with stable exit codes and artifact attachments.
- Playwright reporter integration that links `artifacts/<runId>/report.json`.

### P2 - Provider Gateway and Telemetry Story Is Smaller

Passmark supports gateway routing and optional Axiom/OpenTelemetry. Local supports many providers directly and has model traces, but no gateway abstraction or external trace export.

Impact: teams lose centralized cost/rate-limit dashboards and tracing for model calls.

Recommendation: add a provider-agnostic OpenAI-compatible gateway configuration first, then optional OTLP spans around adapter calls, browser actions, and replay failures.

### P2 - Secure Script Runner Is Missing

Passmark has an AST-validated Playwright script runner for constrained custom steps. Local avoids arbitrary execution, which is safer, but there is no escape hatch for hard-to-model app-specific actions.

Impact: users may overfit prompts instead of writing one stable custom step.

Recommendation: only add this if demand appears. If added, require an allowlisted DSL or AST validator, no arbitrary Node access, no imports, no filesystem/network, and no secret exposure in reports.

### P2 - Docs Index and Product Docs Need Current Competitive Positioning

The local docs now include plan files that are not all indexed from `docs/overview.md`. The README and some roadmap text also call Ollama a stub even though `src/router/adapters/ollama.ts` is implemented.

Impact: auditability and onboarding suffer.

Recommendation: maintain `docs/overview.md` as the full doc index and schedule a docs refresh after each architecture milestone.

## Feature Enhancement Roadmap

1. Refresh canonical docs for planner/navigator, settings, data flow, environment, and route handlers.
2. Add action vocabulary parity for select, hover, keyboard, reload/back, and file upload.
3. Add assertion policy: single ladder, fail-on-disagreement, arbiter-on-disagreement.
4. Add run data placeholders and extraction before full scripting.
5. Add optional step-action cache with effect verification and cache invalidation.
6. Add video assertion mode using extension WebM capture where possible.
7. Add Playwright-facing helper/reporter package for CI adoption.
8. Add OTLP/Axiom-compatible tracing and gateway configuration.

## Performance Opportunities

- Availability probes: local code already caches Ollama availability for 30 seconds, but other adapters still probe frequently. Consider short TTLs for slow CLI/provider probes while preserving the current "can become available mid-run" behavior.
- Prompt size: keep measuring real SPA a11y tree truncation; Passmark's use of Playwright `ariaSnapshot({ mode: "ai" })` is worth comparing against the custom CDP serializer for token count and locator quality.
- Replay selection: add a pre-run matcher that suggests using an existing replay script when task/url match closely, avoiding a new AI run.
- Action cache: use cached actions before navigator calls for common login/cart/setup steps.
- Visual/video budget: route screenshots and video only when the assertion requires visual evidence, preserving the a11y-first cost model.
- Brain escalation cap: current cap prevents runaway smart-model spend; add metrics to prove brain calls stay flat on long flows.

## Competitive Positioning

Do not copy Passmark's shape wholesale. The local product's wedge is stronger when framed as:

"A browser QA subagent for coding agents: one MCP/CLI call, real Chrome, cheap model ladder, artifacts, replay, and fix loop."

Passmark's wedge is:

"An AI Playwright library for writing stable natural-language regression tests."

The most useful borrowings are not the library wrapper itself; they are the features that make natural-language browser tests durable at scale: consensus assertions, action caching, richer actions, dynamic data, extraction, video assertions, and telemetry.

## Update Decision Tree Result

- Runtime code changed: no.
- Env vars changed: no.
- BrowserPort changed: no.
- Report contract changed: no.
- Docs added and indexed: yes, `docs/overview.md` lists this file.
