/* v10 — action batching + fail-on-error verification (real AI run).
 *
 * Two qaRun calls against the fixture (bug OFF), cdp mode, using the daemon
 * ports/profile from loadConfig (nothing else runs on 9322 during verification):
 *
 *  1. Happy path: log in → products → cart → checkout → place order → success.
 *     Assert verdict 'pass' AND that the planner was called ≤ 5 times (it was
 *     8+ unbatched). One planner call == one outer loop iteration == one distinct
 *     `step` among the plan-step model_trace entries.
 *  2. Wrong credentials: the robot is asked to log in with a bad email. The login
 *     page shows "Invalid email or password." after the click; the planner must
 *     finish with verdict 'fail' (NOT loop into 'uncertain') and the reason must
 *     mention invalid/error.
 *
 * Each run is ~1-2 min on Google-CLI free quota. cdp mode leaves Chrome warm —
 * we kill nothing. Exits nonzero on any failed check.
 */

import { qaRun } from '../src/engine.js';
import { startFixture, stopFixture } from '../fixture/server.js';

// Dedicated fixture port so a leftover/other fixture on the default 9401 can't
// collide with this verification run. qaRun uses the daemon ports/profile from
// loadConfig internally (cdp mode reuses the warm Chrome on 9322).
const FIXTURE_PORT = 9411;

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

/** Distinct planner calls = distinct `step` values among plan-step trace entries
 * (a single call can emit several entries when it escalates down the ladder). */
function plannerCalls(report: { model_trace: { capability: string; step: number }[] }): number {
  return new Set(report.model_trace.filter((e) => e.capability === 'plan-step').map((e) => e.step)).size;
}

// ---- 1/2: happy path, expect pass with a small planner-call count ----
console.log('=== v10 1/2: batched happy-path run (bug off) — expecting pass in ≤5 planner calls ===');
const happyServer = startFixture(FIXTURE_PORT, false);
let happy;
try {
  happy = await qaRun(
    'Log in as test@test.com with password pw, add the Widget to the cart, go to the cart, check out, and place the order. The order must end on a confirmation page.',
    `http://localhost:${FIXTURE_PORT}/login`,
    { onProgress: (l) => console.log(`  [happy] ${l}`) },
  );
} finally {
  await stopFixture(happyServer);
}

const happyCalls = plannerCalls(happy);
console.log(
  JSON.stringify(
    { verdict: happy.verdict, reason: happy.reason, plannerCalls: happyCalls, steps: happy.steps.map((s) => s.description) },
    null,
    2,
  ),
);
check('happy run verdict is pass', happy.verdict === 'pass');
check(`happy run used ≤5 planner calls (was ${happyCalls}, unbatched was 8+)`, happyCalls <= 5);

// ---- 2/2: wrong credentials, expect a useful fail (not a loop → uncertain) ----
console.log('\n=== v10 2/2: wrong-credentials run — expecting fail citing the visible error ===');
const wrongServer = startFixture(FIXTURE_PORT, false);
let wrong;
try {
  wrong = await qaRun(
    'Log in as wrong@x.com with password nope and reach the products page',
    `http://localhost:${FIXTURE_PORT}/login`,
    { maxSteps: 6, onProgress: (l) => console.log(`  [wrong] ${l}`) },
  );
} finally {
  await stopFixture(wrongServer);
}

console.log(JSON.stringify({ verdict: wrong.verdict, reason: wrong.reason }, null, 2));
check('wrong-creds run verdict is fail (not uncertain)', wrong.verdict === 'fail');
check(
  'wrong-creds reason mentions invalid/error',
  /invalid|error/i.test(wrong.reason),
);

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v10 checks passed`);
process.exit(failed.length ? 1 : 0);
