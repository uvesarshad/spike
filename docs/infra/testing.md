# Infrastructure: Testing

> Scope: Test strategy, test suite layout, frameworks, and how to run each suite.
> Rendering context: Server-side (Node.js daemon)
> Project tier: 3
> Last updated: 2026-07-07

## Overview

Testing is layered: contract tests (m1–m6) verify interface boundaries without exercising the full stack; e2e tests (e2e.*.ts) run the full engine against the fixture app; numbered integration spikes (v1–v25) are reference experiments that document what was tried. No test framework like Jest or Vitest is used — suites run directly with tsx and assert() / throw.

AGENT OWNER: test/

## Test Layout

test/m1.browser-port.ts — BrowserPort contract. Exercises the full CdpBrowser interface (navigate, click, hover, type, pressKey, selectOption, reload, goBack, screenshot, axTree, drainConsole, drainNetwork) against the fixture app. No model calls.

test/m2.nano-port.ts — NanoPort discrimination. Verifies that Gemini Nano returns 'pass' on the healthy fixture home page and 'fail' (or 'uncertain') on a broken page. Requires Nano to be available.

test/m3.extension-port.ts — ExtensionBrowser contract. Same shape as m1 but over the bridge transport. Requires the extension to be loaded and the daemon bridge to be running.

test/m4.router.ts — ModelRouter escalation. Verifies the ladder ordering, mock adapter fallback, and makes one live Google CLI call to confirm rung 1 is functional.

test/m5.fixture.ts — Fixture sanity (7 checks). Verifies the fixture app's healthy and bug-on endpoints respond correctly via HTTP (no browser). Fast; no Chrome required.

test/m6.mcp.ts — MCP contract. Spawns dist/mcp-server.js as a child process, sends a qa_run tool call over stdio JSON-RPC, and verifies the response shape matches the slim 5-field contract.

test/e2e.run-fixture.ts — The oracle e2e test. Runs qaRun() against the fixture app twice: once with --bug off (expects 'pass') and once with --bug on (expects 'fail' with a console_error containing the TypeError). This is the primary CI gate for the full stack. Run with: npm run test:e2e.

test/e2e.recorder.ts — Recorder proof. Runs qaRun() on the healthy fixture, verifies a QaScript is emitted to generated-tests/, then runs qaReplay() and verifies it returns 'pass' deterministically.

test/e2e.autofix-real.ts — Auto-fix loop e2e. Runs qaRun() on the buggy fixture, triggers the auto-fix loop with a real coding agent, and verifies the next qaRun returns 'pass'. Requires a coding agent CLI on PATH.

test/port-contract.ts — Shared BrowserPort interface assertions imported by m1 and m3. Covers the common action vocabulary so CDP and extension transports remain in parity.

test/v1–v25 (*.ts) — Numbered integration spikes. These are numbered research experiments documenting specific capabilities (clip recording, CDP logpoints, Nano availability probing, etc.). They are reference code, not regression gates. Not imported by the main test suites.

## Test Frameworks

No external test runner is used. Tests use Node.js assert() (strict) and throw on failure. Each suite runs as a standalone tsx script and exits with code 0 (pass) or non-zero (fail). tsx provides TypeScript execution without a build step.

## Running Tests

Full e2e suite (primary CI gate):
npm run test:e2e

Individual contract test (example):
npx tsx test/m1.browser-port.ts

All m* contract tests in sequence (no npm script; run manually):
npx tsx test/m1.browser-port.ts && npx tsx test/m2.nano-port.ts && npx tsx test/m5.fixture.ts && npx tsx test/m6.mcp.ts

Spike regression (frozen reference; keep passing):
cd spikes/cdp-logpoint && npm install && npm run spike

AGENT NOTE: m2 (NanoPort) and m3 (ExtensionBrowser) require specific hardware and setup: Nano needs 22 GB free and the model downloaded; m3 needs the extension bridge running. These are not suitable as automated CI gates on generic runners.

AGENT NOTE: e2e.run-fixture.ts starts the fixture app internally — do not start `qa fixture` manually before running it, or the port will conflict.

## Fixture App as Test Oracle

The fixture app (fixture/server.ts) is intentionally deterministic:
- healthy mode: login succeeds, all products load, checkout completes, /api/order returns 200.
- bug-on mode: checkout throws TypeError (order.total undefined), /api/order returns 500.

This determinism makes the e2e.run-fixture.ts assertion exact: the report must contain the specific TypeError message in console_error.

AGENT AVOID: Do not randomize the fixture app's behavior. The e2e tests assert specific error messages, and the QA spike results documented in docs/browser-qa-subagent-product-doc.md §6.5 depend on this exact behavior.

## What is NOT Tested

- The extension side panel UI (panel.js, overlay.js) — manual testing only; see docs/vibe-panel-manual-test.md.
- The auto-fix loop on CI — requires a real coding agent CLI on PATH.
- Multi-Chrome concurrent runs — manual / ad hoc only.

## Update Triggers

- When a new contract test suite is added (update test layout above).
- When the e2e test command or structure changes.
- When the fixture app bug modes change (the oracle assertions must be updated).
- When the spike regression scripts change.

## Related Docs

- docs/modules/engine.md — qaRun and qaReplay, which the e2e tests exercise
- docs/modules/browser-port.md — BrowserPort contract (m1, m3 test this)
- docs/infra/deployment.md — how to build before running m6 (MCP test requires dist/mcp-server.js)
