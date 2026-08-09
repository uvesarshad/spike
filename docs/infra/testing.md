# Infrastructure: Testing

> Scope: Test strategy, test suite layout, frameworks, and how to run each suite.
> Rendering context: Server-side (Node.js daemon)
> Project tier: 3
> Last updated: 2026-08-09

## Overview

Testing is layered: contract tests (m1, m2, m4, m5, m6 — note there is no m3; the ExtensionBrowser contract test is numbered v3, see below) verify interface boundaries without exercising the full stack; e2e tests (e2e.*.ts) run the full engine against the fixture app; numbered integration spikes and focused regressions (v1-v46) document specific capabilities. No test framework like Jest or Vitest is used; suites run directly with tsx and assert() / throw.

As of 2026-08-09 (A15) there is also a CI gate and an aggregate runner — see "Running Tests" and "Continuous Integration" below.

AGENT OWNER: test/

## Test Layout

test/m1.browser-port.ts - BrowserPort contract. Exercises the full CdpBrowser interface (navigate, click, hover, type, pressKey, selectOption, reload, goBack, screenshot, axTree, drainConsole, drainNetwork) against the fixture app. No model calls.

test/m2.nano-port.ts - NanoPort discrimination. Verifies that Gemini Nano returns 'pass' on the healthy fixture home page and 'fail' (or 'uncertain') on a broken page. Requires Nano to be available.

test/v3.extension-port.ts - ExtensionBrowser contract (misleadingly numbered "v3", NOT "m3" — there is no m3 file in test/). Same shape as m1 (shares test/port-contract.ts's runPortContract) but drives Chrome via chrome.debugger: launchChromeWithExtension dev-loads the MV3 extension over the CDP pipe, BridgeServer accepts the connection, ExtensionBrowser drives the tab through the bridge. Requires the extension to be loaded and the daemon bridge to be running.

test/m4.router.ts - ModelRouter escalation. Part 1 (always runs): escalation policy with fake adapters, no external deps. Part 2 (live, skips gracefully): attempts one live Google CLI call on the spike's bad.png screenshot — since the Gemini CLI free tier died 2026-06-18, this now typically SKIPs (binary not on PATH / not authenticated / IneligibleTierError) rather than PASSing; a skip is not a failure.

test/m5.fixture.ts - Fixture sanity (7 checks). Verifies the fixture app's healthy and bug-on endpoints respond correctly via HTTP (no browser). Fast; no Chrome required.

test/m6.mcp.ts - MCP contract. Spawns dist/mcp-server.js as a child process, sends a qa_run tool call over stdio JSON-RPC, and verifies the response shape matches the slim 5-field contract.

test/e2e.run-fixture.ts - The oracle e2e test. Runs qaRun() against the fixture app twice: once with --bug off (expects 'pass') and once with --bug on (expects 'fail' with a console_error containing the TypeError). This is the primary CI gate for the full stack. Run with: npm run test:e2e.

test/e2e.recorder.ts - Recorder proof. Runs qaRun() on the healthy fixture, verifies a QaScript is emitted to generated-tests/, then runs qaReplay() and verifies it returns 'pass' deterministically.

test/e2e.autofix-real.ts - Auto-fix loop e2e. Runs qaRun() on the buggy fixture, triggers the auto-fix loop with a real coding agent, and verifies the next qaRun returns 'pass'. Requires a coding agent CLI on PATH.

test/port-contract.ts - Shared BrowserPort interface assertions imported by m1 and v3. Covers the common action vocabulary so CDP and extension transports remain in parity.

test/v1-v33 (*.ts) - Numbered integration spikes and focused regressions (gaps and suffixed variants exist, e.g. v17b, v20b; v3 is the ExtensionBrowser contract test documented above, not a generic spike). These document capabilities such as clip recording, CDP logpoints, Nano availability probing, assertion policy, runtime data, action cache, telemetry redaction, gateway helpers, video assertion script handling, the secure script runner, and per-adapter telemetry spans. They are reference code, not imported by the main test suites.

test/v26.assertion-policy.ts - Mock-only visual assertion policy coverage. Verifies single-ladder passthrough, fail-on-disagreement consensus behavior, and arbiter-on-disagreement routing without Chrome or model calls.

test/v27.run-data.ts - Offline unit coverage for runtime `{{run.*}}` placeholder generation/resolution, extraction state helpers, and FakeLocalEmailProvider OTP lookup.

test/v28.action-cache.ts - Pure unit coverage for the action-cache module: key normalization, redaction rejection, file-backed persistence, target rehydration, effect verification, and integration hook notes. No Chrome or model calls.

test/v29.telemetry.ts - Telemetry/gateway helper regression. Verifies the default no-op tracer, mock exporter redaction, and OpenAI-compatible gateway base URL normalization. No browser or network required.

test/v30.video-assertion.ts - Offline coverage for `assert_visual` video mode parsing, QaScript preservation, Playwright comment generation, and role escaping in generated specs.

test/v31.action-cache-driver.ts - Mock BrowserPort/ModelRouter driver coverage proving a first run stores a verified cache action and a second run executes the cached action before the Navigator. No Chrome or network required.

test/v32.script-runner.ts - Secure script runner (Phase 10) coverage in two parts: pure validateScriptSteps() checks (rejects import/require/fs/network/eval/Function/prototype-access patterns, unknown step types, unknown/extra fields, oversized step lists — all without executing anything), and a `script` action driven through the real runDriverLoop with a fake BrowserPort + scripted fake planner, proving an allowlisted script executes in order, a `{{secret:NAME}}` placeholder resolves at execute time without leaking into the report/audit, and a rejected script never touches the browser.

test/v33.trace-spans.ts - Per-adapter/per-action telemetry span coverage (follow-up to Phase 11). Proves ModelRouter emits a redacted `model.call` span per adapter invocation (including down-ladder fallback) through the same always-on tracer + no-op-default machinery v29 covers, and that the driver's `browser.action` span uses the identical getDefaultTracer().startSpan path with non-secret attributes.

## Test Frameworks

No external test runner is used. Tests use Node.js assert() (strict) and throw on failure. Each suite runs as a standalone tsx script and exits with code 0 (pass) or non-zero (fail). tsx provides TypeScript execution without a build step.

## Running Tests

**Aggregate runner (A15, 2026-08-09):** `scripts/run-tests.mjs` discovers every suite under `test/*.ts`, runs each as a standalone `tsx` child process (same house convention as always — no Jest/Vitest introduced), and prints a per-suite PASS/FAIL/SKIP tally. It exits nonzero if anything failed. It classifies every suite into exactly one of two buckets — **not** by filename pattern, but by reading each file for real Chrome/CDP usage (`CdpBrowser`, `chrome-remote-interface`, `launchChromeWithExtension`) or a real bound network socket (`BridgeServer`, the fixture HTTP server, a full `qaRun` in `cdp` mode) versus an explicit "no Chrome / offline / mock" self-description in the suite's own header comment:

```
npm test            # fast bucket: 26 suites, pure/in-memory, pooled (concurrency ~min(4, cpus-1))
npm run test:browser # browser bucket: 28 suites, real Chrome/sockets, run SERIALLY (fixed ports)
npm run test:e2e     # unchanged: tsx test/e2e.run-fixture.ts directly (the single primary oracle)
node scripts/run-tests.mjs --list   # print the bucket assignment without running anything
```

The browser bucket **must** run one suite at a time — the suites themselves document a shared, deliberately-disjoint set of hardcoded ports (9322/9332/9401/9402/9411/9427/...) that only stay collision-free if nothing else is listening; `run-tests.mjs --browser` runs them in a straight `for` loop for exactly this reason. The fast bucket has no such constraint (each suite is in-memory or uses ephemeral `mkdtemp`/random ports), so it's pooled.

Individual contract test (example):
npx tsx test/m1.browser-port.ts

Action-cache unit test:
npx tsx test/v28.action-cache.ts

Action-cache driver wiring test:
npx tsx test/v31.action-cache-driver.ts

Script runner unit + wiring test:
npx tsx test/v32.script-runner.ts

Telemetry span coverage:
npx tsx test/v33.trace-spans.ts

Spike regression (frozen reference; keep passing):
cd spikes/cdp-logpoint && npm install && npm run spike

AGENT NOTE: m2 (NanoPort) and v3 (ExtensionBrowser) require specific hardware and setup: Nano needs 22 GB free and the model downloaded; v3 needs the extension bridge running (chrome.debugger + BridgeServer). These are why they're in the browser bucket, not suitable as automated CI gates on generic runners.

AGENT NOTE: e2e.run-fixture.ts starts the fixture app internally. Do not start `spike fixture` manually before running it, or the port will conflict.

AGENT NOTE: `test/port-contract.ts` is excluded from both buckets — it's a shared library (`runPortContract()`) imported by m1 and v3, not a standalone entry point (no top-level execution, no `process.exit`). Running it directly via tsx is a silent no-op, so `run-tests.mjs` skips it entirely rather than counting it as a suite.

## Continuous Integration

`.github/workflows/ci.yml`, added 2026-08-09 (A15), has two jobs:

- **`test`** runs on every push and PR: `npm ci` → `npm run typecheck` → `npm run build` → `npm test` (the fast bucket only). This is a real gate — a regression in any of the 26 fast suites fails the build.
- **`browser-suites`** is `workflow_dispatch`-only (manual trigger, never on push/PR). It runs `npm run test:browser`. It is deliberately NOT part of the default gate: a stock GitHub-hosted runner has Chromium, not branded Chrome (several paths — extension dev-loading, Gemini Nano's Prompt API — are branded-Chrome-specific); Nano needs a ~2GB model plus 22GB free already provisioned, which nothing can trigger unattended in CI; `e2e.autofix-real.ts`/`v10.batching.ts`/`v20b.measure.ts` need live model/agent credentials; and the fixed-port suites need to run alone on a machine, which a shared CI fleet doesn't guarantee. The workflow file documents each of these inline. Treat `browser-suites` as a human-triggered smoke test on a machine that mirrors a real dev setup, not as a CI gate — a green `test` job does NOT mean the Chrome-driving half of the suite passed.

**History worth knowing:** `test/e2e.run-fixture.ts` and `test/e2e.recorder.ts` were both failing silently for some time before 2026-08-09, because `config.readOnly` defaults to `true` (a safety posture for driving arbitrary user-owned sites) and neither suite opted out — so every type/click against the fixture app they start themselves was silently a no-op. `e2e.run-fixture.ts` could never log in, so both its "expect pass" and "expect a captured error" branches were unreachable; `e2e.recorder.ts` never got a script into `generated-tests/`, so the whole record→replay→heal chain it exists to prove died at the first `loadScript()`. Both now explicitly pass `{ ...cfg, readOnly: false }` (see the `A1` comments in each file). Neither suite was wired into any CI, so this went unnoticed — exactly the class of bug a real CI gate exists to catch, which is the practical case for A15 beyond "it'd be nice to have a green badge."

## Fixture App as Test Oracle

The fixture app (fixture/server.ts) is intentionally deterministic:
- healthy mode: login succeeds, all products load, checkout completes, /api/order returns 200.
- bug-on mode: checkout throws TypeError (order.total undefined), /api/order returns 500.

This determinism makes the e2e.run-fixture.ts assertion exact: the report must contain the specific TypeError message in console_error.

AGENT AVOID: Do not randomize the fixture app's behavior. The e2e tests assert specific error messages, and the QA spike results documented in docs/spike-agent-product-doc.md Section 6.5 depend on this exact behavior.

## What is NOT Tested

- **On every push/PR (the default `test` CI job):** none of the 28 browser-bucket suites run — that's the entire real-Chrome, real-extension-bridge, real-Nano, and live-model-call surface of the project (m1, m2, m5, m6, v1, v3, v5, v6, v7, v8, v9, v10, v11, v14–v19, v20b, v21, v22, v24, v45, and all three `e2e.*` suites, including the primary oracle `e2e.run-fixture.ts`). A green push/PR check means the ~26 pure/unit suites pass and the project builds and typechecks — it says nothing about whether a real Chrome run still works. Run `npm run test:browser` locally, or trigger the manual `browser-suites` GitHub Actions job, to actually exercise that surface.
- The extension side panel UI (panel.js, overlay.js): manual testing only; see docs/vibe-panel-manual-test.md.
- The auto-fix loop on CI: requires a real coding agent CLI on PATH (`e2e.autofix-real.ts` self-gates behind `SPIKE_REAL_AGENT_E2E=1` for this reason and is excluded from the automated `browser-suites` job's normal env).
- Multi-Chrome concurrent runs: manual / ad hoc only.
- Whether the browser-bucket suites still pass at all, on any schedule — `browser-suites` is manual-trigger only, so nothing runs it unless a human remembers to. There is no scheduled (`cron`) run of it.

## Update Triggers

- When a new contract test suite is added.
- When the e2e test command or structure changes.
- When the fixture app bug modes change.
- When the spike regression scripts change.
- When action-cache, assertion-policy, video assertion, runtime data, telemetry, gateway, script-runner, or trace-span coverage changes.
- When a test file is renumbered/renamed (e.g. the v3-not-m3 extension-port contract naming) — verify against `ls test/` rather than trusting this doc.
- When a new suite is added: classify it into `scripts/run-tests.mjs`'s `BROWSER_SUITES` (real Chrome/CDP or a real bound socket) or leave it to fall into the fast bucket by default — verify with `node scripts/run-tests.mjs --list`, don't guess from the filename.
- When `.github/workflows/ci.yml`'s jobs, triggers, or the browser-bucket exclusion reasons change.

## Related Docs

- docs/modules/engine.md - qaRun and qaReplay, which the e2e tests exercise
- docs/modules/browser-port.md - BrowserPort contract (m1, v3 test this)
- docs/modules/action-cache.md - v28 unit coverage and v31 driver wiring coverage
- docs/infra/deployment.md - how to build before running m6
- .github/workflows/ci.yml - the CI gate itself (A15)
- scripts/run-tests.mjs - the aggregate runner and fast/browser bucket assignment (A15)

## The AI-driven e2e suites are inherently non-deterministic

`test/e2e.run-fixture.ts` and `test/e2e.recorder.ts` drive a real model. The
same commit can produce 6/6 on one run and 5/6 on the next — observed
2026-08-09, where the bug-on run correctly reported `fail` but reached its
verdict via a visual assertion on the Checkout page instead of clicking
"Place order", so the intentional TypeError never fired and the
"captured a console/network error" check went red. Re-running the identical
build passed 6/6.

Practical consequence: **a single red run of these two suites is not a
regression.** Re-run before investigating, and only treat a failure as real if
it reproduces. This is the same property the product's own flake control
(audit A11 — `retries`, the `flaky` marker, `.spike-quarantine.json`) exists to
manage for users' suites; these two gates do not yet use it on themselves.

The deterministic suites have no such caveat — `npm test` and the replay path
are expected to be bit-stable, and a red there IS a regression.
