# Infrastructure: Testing

> Scope: Test strategy, test suite layout, frameworks, and how to run each suite.
> Rendering context: Server-side (Node.js daemon)
> Project tier: 3
> Last updated: 2026-07-18

## Overview

Testing is layered: contract tests (m1, m2, m4, m5, m6 — note there is no m3; the ExtensionBrowser contract test is numbered v3, see below) verify interface boundaries without exercising the full stack; e2e tests (e2e.*.ts) run the full engine against the fixture app; numbered integration spikes and focused regressions (v1-v33) document specific capabilities. No test framework like Jest or Vitest is used; suites run directly with tsx and assert() / throw.

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

Full e2e suite (primary CI gate):
npm run test:e2e

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

All m* contract tests in sequence (no npm script; run manually):
npx tsx test/m1.browser-port.ts && npx tsx test/m2.nano-port.ts && npx tsx test/m5.fixture.ts && npx tsx test/m6.mcp.ts

Spike regression (frozen reference; keep passing):
cd spikes/cdp-logpoint && npm install && npm run spike

AGENT NOTE: m2 (NanoPort) and v3 (ExtensionBrowser) require specific hardware and setup: Nano needs 22 GB free and the model downloaded; v3 needs the extension bridge running (chrome.debugger + BridgeServer). These are not suitable as automated CI gates on generic runners.

AGENT NOTE: e2e.run-fixture.ts starts the fixture app internally. Do not start `qa fixture` manually before running it, or the port will conflict.

## Fixture App as Test Oracle

The fixture app (fixture/server.ts) is intentionally deterministic:
- healthy mode: login succeeds, all products load, checkout completes, /api/order returns 200.
- bug-on mode: checkout throws TypeError (order.total undefined), /api/order returns 500.

This determinism makes the e2e.run-fixture.ts assertion exact: the report must contain the specific TypeError message in console_error.

AGENT AVOID: Do not randomize the fixture app's behavior. The e2e tests assert specific error messages, and the QA spike results documented in docs/browser-qa-subagent-product-doc.md Section 6.5 depend on this exact behavior.

## What is NOT Tested

- The extension side panel UI (panel.js, overlay.js): manual testing only; see docs/vibe-panel-manual-test.md.
- The auto-fix loop on CI: requires a real coding agent CLI on PATH.
- Multi-Chrome concurrent runs: manual / ad hoc only.

## Update Triggers

- When a new contract test suite is added.
- When the e2e test command or structure changes.
- When the fixture app bug modes change.
- When the spike regression scripts change.
- When action-cache, assertion-policy, video assertion, runtime data, telemetry, gateway, script-runner, or trace-span coverage changes.
- When a test file is renumbered/renamed (e.g. the v3-not-m3 extension-port contract naming) — verify against `ls test/` rather than trusting this doc.

## Related Docs

- docs/modules/engine.md - qaRun and qaReplay, which the e2e tests exercise
- docs/modules/browser-port.md - BrowserPort contract (m1, v3 test this)
- docs/modules/action-cache.md - v28 unit coverage and v31 driver wiring coverage
- docs/infra/deployment.md - how to build before running m6
