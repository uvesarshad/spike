#!/usr/bin/env node
/* run-tests.mjs — aggregate runner for the project's tsx-script test suites
 * (A15, docs/plan/26-08-08-audit-deterministic-speed.md).
 *
 * The house convention is standalone `tsx` scripts that print PASS/FAIL/SKIP
 * lines and process.exit(nonzero) on failure — no Jest/Vitest. This runner
 * does not change that; it just discovers `test/*.ts`, runs each as a child
 * `tsx` process, and aggregates the results.
 *
 * Two buckets, because they have very different cost/environment profiles:
 *
 *   - FAST  (`npm test`): pure/in-memory suites. No real Chrome, no real
 *     network servers, no fixed ports. Safe to run anywhere (including a
 *     stock GitHub-hosted runner) and safe to run concurrently with each
 *     other, so they're pooled with a small concurrency limit.
 *
 *   - BROWSER (`npm run test:browser`): suites that drive a real Chrome via
 *     CDP (CdpBrowser / chrome-remote-interface / launchChromeWithExtension),
 *     spin up a real BridgeServer/fixture-server socket, or otherwise bind
 *     fixed local ports (9322/9332/9401/9402/9411/...). These MUST run
 *     serially — they collide with each other on ports if parallelised —
 *     and need a real branded Chrome (plus, for some, a downloaded Gemini
 *     Nano model or live model credentials) that a stock CI runner does not
 *     have. See docs/infra/testing.md and .github/workflows/ci.yml for why
 *     these are opt-in (workflow_dispatch), not part of the default push/PR
 *     gate.
 *
 * The bucket assignment below was produced by reading every file in test/ —
 * not by guessing from the filename — looking for CdpBrowser / chrome-remote-
 * interface / launchChromeWithExtension / BridgeServer / a real listen()ing
 * HTTP server, vs. explicit "no Chrome" / "offline" / "mock" self-description
 * in the suite's own header comment. See docs/infra/testing.md for the
 * per-suite rationale.
 *
 * Usage:
 *   node scripts/run-tests.mjs            # fast bucket (default), pooled
 *   node scripts/run-tests.mjs --browser   # browser bucket, serial
 *   node scripts/run-tests.mjs --list      # print the bucket assignment and exit 0
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const testDir = path.join(repoRoot, 'test');

// Suites that are not standalone entry points at all — shared library code
// imported by other suites (no process.exit, no top-level run). Running them
// directly is a no-op, not a test, so they're excluded from both buckets.
const NOT_A_SUITE = new Set(['port-contract.ts']);

// Suites that drive a real Chrome (CDP / chrome-remote-interface /
// launchChromeWithExtension) and/or bind a real network socket (BridgeServer,
// the fixture HTTP server, a full qaRun against real CDP). Must run serially.
const BROWSER_SUITES = [
  'm1.browser-port.ts', // real CdpBrowser against a scratch HTTP fixture
  'm2.nano-port.ts', // Gemini Nano via a real Chrome runner page; needs the 22GB-gated model
  'm5.fixture.ts', // starts the fixture HTTP server + drives it via real CdpBrowser
  'm6.mcp.ts', // starts the fixture server, spawns dist/mcp-server.js, runs a real qa_run (real Chrome under the hood)
  'v1.load-extension.ts', // launchChromeWithExtension + chrome-remote-interface
  'v3.extension-port.ts', // ExtensionBrowser contract: real chrome.debugger + BridgeServer
  'v5.engine-via-extension.ts', // real engine + BridgeServer + spawned Chrome
  'v6.extension-nano.ts', // real Chrome extension + Nano over the bridge
  'v7.vibe-service.ts', // real BridgeServer socket (no Chrome, but a real bound port)
  'v8.overlay.ts', // launchChromeWithExtension, real CDP
  'v9.vibe-flow.ts', // launchChromeWithExtension + real BridgeServer
  'v10.batching.ts', // real qaRun (cdp mode) against the fixture — a live AI run
  'v11.attach-tab.ts', // launchChromeWithExtension + BridgeServer
  'v14.clip.ts', // spins the fixture + a throwaway headless Chrome over CDP
  'v15.recorder-robustness.ts', // real CdpBrowser + chrome-remote-interface
  'v16.clip-input-interaction.ts', // real CdpBrowser
  'v17.vibe-stall-probe.ts', // launchChromeWithExtension + BridgeServer
  'v17b.sw-state-probe.ts', // launchChromeWithExtension + BridgeServer + chrome-remote-interface
  'v18.react-typing.ts', // real CdpBrowser
  'v19.tabcapture.ts', // launchChromeWithExtension + BridgeServer
  'v20b.measure.ts', // one real measured qaRun against a throwaway Chrome profile, needs internet + gemini CLI
  'v21.locators.ts', // real CdpBrowser + chrome-remote-interface
  'v22.clip-share.ts', // real BridgeServer socket
  'v24.multiplex.ts', // launchChromeWithExtension, two real Chromes on one bridge
  'v45.playwright-port.ts', // real CDP + fixture server, PlaywrightPort transport
  'e2e.run-fixture.ts', // full-stack qaRun against the fixture, the primary oracle
  'e2e.recorder.ts', // full-stack qaRun + qaReplay against the fixture
  'e2e.autofix-real.ts', // real `claude` CLI + real qaRun; gated behind SPIKE_REAL_AGENT_E2E=1
];

const BROWSER_SET = new Set(BROWSER_SUITES);

function discoverSuites() {
  const all = fs
    .readdirSync(testDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => e.name)
    .filter((name) => !NOT_A_SUITE.has(name))
    .sort();

  const missing = BROWSER_SUITES.filter((name) => !all.includes(name));
  if (missing.length) {
    console.error(`run-tests.mjs: BROWSER_SUITES references files that no longer exist: ${missing.join(', ')}`);
    process.exit(1);
  }

  const fast = all.filter((name) => !BROWSER_SET.has(name));
  const browser = all.filter((name) => BROWSER_SET.has(name));
  return { fast, browser };
}

const tsxBin = path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');

function runSuite(name) {
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn(tsxBin, [path.join('test', name)], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code) => {
      const ms = Date.now() - start;
      const status = code === 0 ? 'PASS' : code === 2 ? 'SKIP' : 'FAIL';
      resolve({ name, status, code: code ?? 1, ms });
    });
    child.on('error', (err) => {
      const ms = Date.now() - start;
      console.error(`run-tests.mjs: failed to spawn ${name}: ${err.message}`);
      resolve({ name, status: 'FAIL', code: 1, ms });
    });
  });
}

async function runPooled(names, concurrency) {
  const results = [];
  let next = 0;
  async function worker() {
    while (next < names.length) {
      const i = next++;
      results[i] = await runSuite(names[i]);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, names.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function runSerial(names) {
  const results = [];
  for (const name of names) {
    results.push(await runSuite(name));
  }
  return results;
}

function printTally(label, results) {
  console.log(`\n=== ${label} tally ===`);
  for (const r of results) {
    console.log(`${r.status.padEnd(4)}  ${r.name}  (${r.ms}ms)`);
  }
  const pass = results.filter((r) => r.status === 'PASS').length;
  const skip = results.filter((r) => r.status === 'SKIP').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  console.log(`${label}: ${pass} passed, ${skip} skipped, ${fail} failed, ${results.length} total`);
  return fail;
}

async function main() {
  const args = process.argv.slice(2);
  const { fast, browser } = discoverSuites();

  if (args.includes('--list')) {
    console.log(`Fast suites (${fast.length}):\n  ${fast.join('\n  ')}`);
    console.log(`\nBrowser suites (${browser.length}):\n  ${browser.join('\n  ')}`);
    if (NOT_A_SUITE.size) console.log(`\nExcluded (not a suite): ${[...NOT_A_SUITE].join(', ')}`);
    return;
  }

  const wantBrowser = args.includes('--browser');
  const names = wantBrowser ? browser : fast;
  const label = wantBrowser ? 'browser' : 'fast';

  if (!names.length) {
    console.error(`run-tests.mjs: no suites discovered for bucket "${label}"`);
    process.exit(1);
  }

  console.log(`run-tests.mjs: running ${names.length} ${label} suite(s)${wantBrowser ? ' serially' : ' pooled'}...\n`);

  const results = wantBrowser
    ? await runSerial(names)
    : await runPooled(names, Number(process.env.RUN_TESTS_CONCURRENCY) || Math.max(1, Math.min(4, os.cpus().length - 1)));

  const failCount = printTally(label, results);
  process.exit(failCount > 0 ? 1 : 0);
}

main();
