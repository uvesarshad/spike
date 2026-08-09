/* The e2e oracle (M5 verification): qa_run against the fixture app in both
 * modes. Healthy → pass. Bug on → fail with console_error populated and a
 * failing screenshot among the evidence. Exits nonzero on regression.
 *
 * Heads-up: every planner step is a Google-CLI call (~10-25s each on free
 * quota) — a full double run takes several minutes. */

import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { qaRun } from '../src/engine.js';
import { startFixture, stopFixture } from '../fixture/server.js';

const cfg = loadConfig();
const TASK =
  'Log in as test@test.com with password pw, add the Widget to the cart, go to the cart, check out, and place the order. The order must end on a confirmation page.';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

async function runAgainstFixture(bug: boolean) {
  const server = startFixture(cfg.fixturePort, bug);
  try {
    return await qaRun(TASK, `http://localhost:${cfg.fixturePort}/login`, {
      onProgress: (l) => console.log(`  [${bug ? 'bug-on' : 'healthy'}] ${l}`),
      // A1: `readOnly` defaults to TRUE (config.ts) as a safety posture for
      // arbitrary user sites. This gate drives a fixture app it starts and
      // stops itself on localhost, so the default made every action a no-op —
      // the run could never log in, so "expecting pass" and "expecting a
      // captured error" were both unreachable and this suite had been failing
      // silently. Opting out here is the whole point of the fixture.
      config: { ...cfg, readOnly: false },
      // This gate exists to exercise the FULL AI stack (brain → navigator →
      // ports → verdict) against both fixture modes. Once A1 landed a recorded
      // script in generated-tests/, the pre-run matcher started recognising
      // this exact task+url and short-circuiting into a $0 replay — so the
      // suite silently stopped testing the thing it is named for. The recorder
      // path has its own dedicated gate (test/e2e.recorder.ts).
      replay: false,
    });
  } finally {
    await stopFixture(server);
  }
}

console.log('=== e2e 1/2: healthy fixture — expecting pass ===');
const healthy = await runAgainstFixture(false);
console.log(JSON.stringify({ verdict: healthy.verdict, reason: healthy.reason, steps: healthy.steps.map((s) => s.description) }, null, 2));
check('healthy run verdict is pass', healthy.verdict === 'pass');
check('healthy run has no console_error', healthy.console_error === null);

console.log('\n=== e2e 2/2: bug-on fixture — expecting fail with evidence ===');
const broken = await runAgainstFixture(true);
console.log(JSON.stringify({ verdict: broken.verdict, reason: broken.reason, console_error: broken.console_error, failing_step: broken.failing_step, steps: broken.steps.map((s) => s.description) }, null, 2));
check('bug-on run verdict is fail', broken.verdict === 'fail');
check('bug-on run captured a console/network error', Boolean(broken.console_error));
check(
  'bug-on run produced a screenshot in evidence_paths',
  broken.evidence_paths.some((p) => p.endsWith('.png') && fs.existsSync(p)),
);
check('report.json exists on disk', fs.existsSync(broken.evidence_paths[0]));

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} e2e checks passed`);
process.exit(failed.length ? 1 : 0);
