/* e2e — the REAL quality gate for the auto-fix loop.
 *
 * v12 proves the auto-fix wiring with a STUB agent + injected runFn. THIS test
 * proves the whole thing for real: the actual `claude` CLI (on PATH on this
 * machine) is handed the fix prompt for a genuinely-broken on-disk app, edits
 * the file, and the re-run goes green. It spends real agent tokens, so it is
 * double-gated:
 *
 *   - `claude --version` must exit 0 (else exit 2 / skip),
 *   - env SPIKE_REAL_AGENT_E2E=1 must be set (else exit 2 / skip).
 *
 * The buggy app (test/fixtures/buggy-shop) is COPIED to a temp work dir so the
 * agent edits the copy and the repo's pristine fixture is never touched. We then
 * run runWithAutoFix with fixAgentCwd pointed at that temp dir (dispatchFix sets
 * the child's cwd to it, so `claude` edits files THERE).
 *
 * Asserts: final verdict pass, exactly one fix dispatched (attempt 1 fail →
 * fixed, attempt 2 pass), and the temp checkout.js actually changed (now
 * contains `total` in buildOrder's returned object).
 *
 * Run:  $env:SPIKE_REAL_AGENT_E2E='1'; npx tsx test/e2e.autofix-real.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runWithAutoFix } from '../src/vibe/auto-fix.js';
import { startBuggyShop, stopBuggyShop } from './fixtures/buggy-shop/serve.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, 'fixtures', 'buggy-shop');
const PORT = 9421;

/* The canned checkout task — identical to test/e2e.run-fixture.ts so the planner
 * walks login → products → cart → checkout → place order → confirmation. */
const TASK =
  'Log in as test@test.com with password pw, add the Widget to the cart, go to the cart, check out, and place the order. The order must end on a confirmation page.';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

/* ---- preflight (skip gates) ------------------------------------------------ */

function claudeWorks(): boolean {
  try {
    const r = spawnSync('claude --version', { shell: true, stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

if (!claudeWorks()) {
  console.log('SKIP  `claude --version` did not exit 0 — install Claude Code on PATH to run this e2e.');
  process.exit(2);
}
if (process.env.SPIKE_REAL_AGENT_E2E !== '1') {
  console.log('SKIP  set SPIKE_REAL_AGENT_E2E=1 to run the paid e2e (it spends real agent tokens).');
  process.exit(2);
}

/* ---- copy the fixture to a throwaway work dir ------------------------------ */

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-autofix-real-'));
const appDir = path.join(workRoot, 'buggy-shop');
fs.cpSync(FIXTURE_DIR, appDir, { recursive: true });
console.log(`work dir: ${appDir}`);

const checkoutPath = path.join(appDir, 'checkout.js');
const originalCheckout = fs.readFileSync(checkoutPath, 'utf8');

/* ---- run ------------------------------------------------------------------- */

// Serve from the TEMP copy — so the agent's edits (made under appDir) are the
// files the re-test actually loads. The repo fixture stays pristine.
const server = startBuggyShop(PORT, appDir);
const t0 = Date.now();
let result: Awaited<ReturnType<typeof runWithAutoFix>> | undefined;

try {
  result = await runWithAutoFix(TASK, `http://localhost:${PORT}/login`, {
    maxAttempts: 2,
    // dispatchFix runs the agent with cwd = fixAgentCwd, so `claude` edits the
    // COPY. No fixAgentBin override → auto-detect finds claude on PATH with its
    // default args (`-p {prompt} --permission-mode acceptEdits`).
    config: { fixAgentCwd: appDir },
    onProgress: (l) => console.log(`  [autofix] ${l}`),
    qaRunOpts: { record: false },
  });
} catch (e) {
  console.error('runWithAutoFix threw:', e instanceof Error ? e.stack : e);
} finally {
  await stopBuggyShop(server);
}

const wallMs = Date.now() - t0;
console.log(`\ntotal wall time: ${(wallMs / 1000).toFixed(1)}s`);

/* ---- asserts --------------------------------------------------------------- */

if (!result) {
  check('runWithAutoFix returned a result', false);
} else {
  const { finalReport, attempts } = result;
  console.log(
    'attempts:',
    JSON.stringify(attempts),
    '\nfinal verdict:',
    finalReport.verdict,
    '\nfinal reason:',
    finalReport.reason,
  );

  check('final verdict is pass', finalReport.verdict === 'pass');
  check('recorded exactly 2 attempts (fail → fix → pass)', attempts.length === 2);
  // Attempt 1 is non-pass (the bug crashes the page). The planner surfaces this
  // as either 'fail' (deterministic TypeError) or 'uncertain' (it gave up after
  // repeated clicks did nothing) — BOTH are non-pass and BOTH correctly trigger
  // a fix dispatch. What matters is: it wasn't a pass, and a fix WAS dispatched.
  check(
    'attempt 1 did not pass and was fixed',
    attempts[0]?.verdict !== 'pass' && attempts[0]?.fixed === true,
  );
  check('attempt 2 is the pass', attempts[1]?.verdict === 'pass');
  const fixedCount = attempts.filter((a) => a.fixed === true).length;
  check('exactly one fix was dispatched', fixedCount === 1);
}

const fixedCheckout = fs.existsSync(checkoutPath) ? fs.readFileSync(checkoutPath, 'utf8') : '';
const changed = fixedCheckout !== originalCheckout;
check('checkout.js actually changed on disk', changed);
check('the fix adds `total` to the returned order object', /buildOrder[\s\S]*?return\s*{[^}]*\btotal\b/.test(fixedCheckout));

if (changed) {
  console.log('\n--- checkout.js after the agent edit ---');
  console.log(fixedCheckout);
}

/* ---- cleanup --------------------------------------------------------------- */

try { fs.rmSync(workRoot, { recursive: true, force: true }); } catch { /* best effort */ }

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} e2e checks passed`);
process.exit(failed.length ? 1 : 0);
