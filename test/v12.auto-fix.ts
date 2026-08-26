/* V12 — auto-fix loop verification. NO Chrome, NO real coding agent.
 *
 * The CLI-coding-agent loop (test fails → fix prompt handed to the agent
 * headlessly → agent edits → re-test) is exercised with a STUB agent and an
 * injectable runFn, so the whole thing runs offline and deterministically.
 *
 * Part 1 (dispatchFix → stub): a stub.js is invoked via config override
 * (fixAgentBin 'node', fixAgentArgs ['<stub.js>', '{prompt}']). With bin 'node'
 * there's no .cmd shim, so spawn gets real argv fidelity. The stub asserts it
 * received either the stdin-pointer text or a temp-file pointer, reads the actual
 * prompt (from stdin or the file), writes it to a marker file, exits 0. We assert
 * the marker contains 'Steps to reproduce' and dispatchFix returns ok===true.
 *
 * Part 2 (detectFixAgent): returns something on this machine (claude IS on PATH)
 * or skips gracefully (no agent installed in CI → not a failure).
 *
 * Part 3 (runWithAutoFix loop): a fake runFn returns fail-then-pass; with the
 * stub as the fix agent we assert maxAttempts cycles ran, dispatchFix ran exactly
 * once, and the final verdict is pass. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dispatchFix,
  detectFixAgent,
  runWithAutoFix,
  __resetDetectCache,
  type RunFn,
} from '../src/vibe/auto-fix.js';
import { SettingsStore } from '../src/vibe/settings.js';
import type { Report } from '../src/report/report.js';
import type { QaRunResult } from '../src/engine.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

/* ---- shared fixtures ------------------------------------------------------- */

const ts = Date.UTC(2026, 5, 7, 12, 0, 0);

function cannedFailingReport(): Report {
  return {
    verdict: 'fail',
    failing_step: { index: 1, action: { type: 'click', nodeId: 'n9' }, description: 'click n9' },
    console_error: "TypeError: Cannot read properties of undefined (reading 'total')",
    evidence_paths: ['artifacts/run-x/report.json', 'artifacts/run-x/screenshots/step-01.png'],
    reason: 'clicking Place order crashed the page',
    runId: 'run-x',
    task: 'Test the checkout flow places an order',
    url: 'http://localhost:9401/checkout',
    steps: [
      {
        index: 0,
        action: { type: 'navigate', url: 'http://localhost:9401/checkout' },
        description: 'navigate',
        ok: true,
        console: [],
        network: [],
        ts,
      },
      {
        index: 1,
        action: { type: 'click', nodeId: 'n9' },
        description: 'click n9',
        target: { role: 'button', name: 'Place order' },
        ok: false,
        error: 'page crashed',
        console: [{ ts, level: 'error', text: "TypeError: Cannot read properties of undefined (reading 'total')" }],
        network: [{ ts, method: 'POST', url: 'http://localhost:9401/api/order', status: 500, ms: 12, failed: false }],
        screenshot: 'artifacts/run-x/screenshots/step-01.png',
        ts: ts + 1000,
      },
    ],
    model_trace: [],
    durationMs: 4200,
    tokenEstimate: 0,
  };
}

/** A throwaway dir for the stub script + its marker file. */
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-v12-'));
// A16: isolated settings file so the auto-fix consent gate never touches the
// real user config/vault during this offline test.
const settingsStore = new SettingsStore(path.join(work, 'settings.json'));
const stubPath = path.join(work, 'stub.js');
const markerPath = path.join(work, 'marker.txt');

/* The stub coding agent. Receives one argv that is EITHER the stdin pointer
 * ('Apply the fix described on stdin.') or a temp-file pointer ('Apply the fix
 * described in <abs>. Read that file first.'). It recovers the real prompt
 * accordingly, writes it to the marker, and exits 0 — a "fix" that changes no
 * code but proves the dispatch wiring end-to-end. */
const STUB_SRC = `
import fs from 'node:fs';

const MARKER = ${JSON.stringify(markerPath)};
const pointer = process.argv[2] ?? '';

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => resolve(buf));
    // if nothing is piped, end fires immediately on a closed stdin
    if (process.stdin.isTTY) resolve('');
  });
}

const fileMatch = /Apply the fix described in (.+)\\. Read that file first\\.$/.exec(pointer);
let prompt;
let mode;
if (fileMatch) {
  mode = 'file';
  prompt = fs.readFileSync(fileMatch[1].trim(), 'utf8');
} else if (pointer.includes('Apply the fix described on stdin.')) {
  mode = 'stdin';
  prompt = await readStdin();
} else {
  // unexpected: record the raw pointer so the assertion fails loudly
  mode = 'unknown';
  prompt = 'UNEXPECTED_POINTER:' + pointer;
}

fs.writeFileSync(MARKER, '[' + mode + ']\\n' + prompt, 'utf8');
process.exit(0);
`;

fs.writeFileSync(stubPath, STUB_SRC, 'utf8');

/* ---- Part 1: dispatchFix → stub -------------------------------------------- */

async function dispatchTests(): Promise<void> {
  if (fs.existsSync(markerPath)) fs.rmSync(markerPath);

  const progress: string[] = [];
  const res = await dispatchFix(cannedFailingReport(), {
    config: {
      // bin 'node' → no .cmd shim → spawn gets real argv fidelity even with shell:true.
      fixAgentBin: 'node',
      fixAgentArgs: [stubPath, '{prompt}'],
      fixAgentCwd: work,
    },
    confirmed: true, settingsStore, // A16: test exercises the automated dispatch path directly, not the consent gate
    onProgress: (l) => progress.push(l),
  });

  check('dispatchFix returns ok===true (stub exited 0)', res.ok === true);
  check('dispatchFix reports the agent bin', res.agent === 'node');
  check('dispatchFix emitted a progress line', progress.length > 0);

  const marker = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8') : '';
  check('stub was invoked (marker written)', marker.length > 0);
  check('marker carries the real fix prompt (Steps to reproduce)', marker.includes('Steps to reproduce'));
  check('marker carries the console error verbatim', marker.includes("reading 'total'"));
  // bin 'node' is a known candidate? no — it's a config override → file delivery.
  check('node override used file delivery (marker tagged [file])', marker.startsWith('[file]'));

  // pass verdict → dispatchFix refuses (nothing to fix)
  let refused = false;
  try {
    await dispatchFix(
      { ...cannedFailingReport(), verdict: 'pass', console_error: null, failing_step: null },
      { confirmed: true, settingsStore },
    );
  } catch {
    refused = true;
  }
  check('dispatchFix throws on a pass verdict (empty fix prompt)', refused);
}

/* ---- Part 2: detectFixAgent ------------------------------------------------ */

async function detectTests(): Promise<void> {
  __resetDetectCache();
  const detected = await detectFixAgent();
  if (detected) {
    check('detectFixAgent found an agent on PATH', ['claude', 'codex', 'gemini'].includes(detected.bin));
    check('detected agent carries a {prompt} arg template', detected.args.includes('{prompt}'));
  } else {
    console.log('SKIP  no coding agent on PATH (acceptable in CI)');
  }
  // cache is populated/cleared cleanly
  const again = await detectFixAgent();
  check('detectFixAgent cache is stable across calls', JSON.stringify(again) === JSON.stringify(detected));
}

/* ---- Part 3: runWithAutoFix loop (injected runFn) -------------------------- */

async function loopTests(): Promise<void> {
  if (fs.existsSync(markerPath)) fs.rmSync(markerPath);

  let runCalls = 0;
  const verdicts: Report['verdict'][] = ['fail', 'pass'];
  const fakeRun: RunFn = async (): Promise<QaRunResult> => {
    const verdict = verdicts[Math.min(runCalls, verdicts.length - 1)];
    runCalls++;
    const base = cannedFailingReport();
    return verdict === 'pass'
      ? { ...base, verdict: 'pass', console_error: null, failing_step: null }
      : base;
  };

  const progress: string[] = [];
  const result = await runWithAutoFix('Test the checkout flow', 'http://localhost:9401/checkout', {
    maxAttempts: 2,
    runFn: fakeRun,
    config: { fixAgentBin: 'node', fixAgentArgs: [stubPath, '{prompt}'], fixAgentCwd: work },
    confirmed: true, settingsStore, // A16: test exercises the automated loop directly, not the consent gate
    onProgress: (l) => progress.push(l),
  });

  check('runWithAutoFix ran qaRun twice (fail → fix → pass)', runCalls === 2);
  check('final verdict is pass', result.finalReport.verdict === 'pass');
  check('recorded 2 attempts', result.attempts.length === 2);
  check('attempt 1 marked fixed', result.attempts[0]?.fixed === true);
  check('attempt 2 is the pass', result.attempts[1]?.verdict === 'pass');
  check('dispatchFix ran exactly once (marker written by the single fix)', fs.existsSync(markerPath));
  check('loop narrated the dispatch', progress.some((l) => l.includes('dispatching fix')));

  // a loop that never fixes still runs exactly maxAttempts cycles
  let stuckCalls = 0;
  const alwaysFail: RunFn = async (): Promise<QaRunResult> => {
    stuckCalls++;
    return cannedFailingReport() as QaRunResult;
  };
  const stuck = await runWithAutoFix('x', 'http://localhost:9401/checkout', {
    maxAttempts: 2,
    runFn: alwaysFail,
    config: { fixAgentBin: 'node', fixAgentArgs: [stubPath, '{prompt}'], fixAgentCwd: work },
    confirmed: true, settingsStore, // A16: test exercises the automated loop directly, not the consent gate
  });
  check('always-fail loop ran exactly maxAttempts (2) cycles', stuckCalls === 2);
  check('always-fail loop final verdict is fail', stuck.finalReport.verdict === 'fail');
  check('always-fail loop last attempt not marked fixed', stuck.attempts[1]?.fixed === false);
}

/* ---- run ------------------------------------------------------------------- */

try {
  await dispatchTests();
  await detectTests();
  await loopTests();
} catch (e) {
  console.error('V12 threw:', e instanceof Error ? e.stack : e);
  check('ran without throwing', false);
} finally {
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v12 checks passed`);
process.exit(failed.length ? 1 : 0);
