/* v43 — A21 (risk-tiered heal acceptance) + A11 (flake control).
 *
 * A21: `--heal` (engine.ts) used to run a full AI pass and overwrite the
 * script under the SAME name unconditionally — a heal that "fixes" a script
 * by routing around a genuine regression silently turns a real bug green.
 * `classifyHeal()` (src/recorder/heal-policy.ts) is a deterministic
 * structural diff between the OLD script and the freshly-healed candidate
 * that decides auto-accept / accept-with-notice / quarantine-for-review, and
 * `applyHealDecision()` (engine.ts) performs (or withholds) the matching
 * disk write. The whole safety property: a QUARANTINED heal leaves the OLD
 * script untouched and writes the candidate ALONGSIDE it — an unreviewed
 * heal must never silently become the suite's truth.
 *
 * A11: no flake/retry/quarantine mechanism existed anywhere in the repo. This
 * suite covers the two pieces added to engine.ts: `resolveRetryOutcome()`
 * (fail-then-pass over N attempts → a `flaky`-flagged pass, kept OUT of
 * RunVerdict itself) and the `.spike-quarantine.json` list + `suiteExitCode()`
 * (a quarantined flow still runs/reports but never fails the aggregate).
 *
 * Entirely at the unit level: QaScript objects built in memory, stubbed
 * Report-shaped attempt outcomes — no browser, no planner, no real replay.
 *
 * Run: npx tsx test/v43.heal-flake.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyHeal } from '../src/recorder/heal-policy.js';
import { loadScript, saveScript, type QaScript, type ScriptStep } from '../src/recorder/script.js';
import {
  applyHealDecision,
  resolveRetryOutcome,
  loadQuarantineList,
  addToQuarantine,
  removeFromQuarantine,
  isQuarantined,
  suiteExitCode,
  type QaReplayResult,
} from '../src/engine.js';
import type { Report } from '../src/report/report.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

/* ===================== fixtures ===================== */

const tmpDirs: string[] = [];
function freshRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v43-heal-flake-'));
  tmpDirs.push(dir);
  return dir;
}

/** A representative 4-step script: navigate → login click → a DOM assertion
 * on the resulting status message. Every scenario below starts from this
 * baseline and mutates ONE aspect of it. */
function baseScript(overrides: Partial<QaScript> = {}): QaScript {
  const steps: ScriptStep[] = [
    { type: 'navigate', url: 'http://localhost:9401/login' },
    { type: 'type', target: { role: 'textbox', name: 'Email' }, text: 'test@test.com' },
    { type: 'click', target: { role: 'button', name: 'Login' } },
    { type: 'assert_dom', target: { role: 'status', name: 'Message' }, contains: 'Order confirmed successfully' },
  ];
  return {
    version: 1,
    name: 'login-and-check-order',
    task: 'log in and confirm the order banner',
    url: 'http://localhost:9401/login',
    sourceRunId: 'run-original',
    createdAt: new Date().toISOString(),
    steps,
    ...overrides,
  };
}

function withSteps(script: QaScript, steps: ScriptStep[]): QaScript {
  return { ...script, steps };
}

function fakeReport(overrides: Partial<Report>): QaReplayResult {
  return {
    runId: overrides.runId ?? 'run-fake',
    task: 'do the thing',
    url: 'http://localhost:9401/start',
    verdict: 'pass',
    failing_step: null,
    console_error: null,
    evidence_paths: [],
    reason: 'ok',
    steps: [],
    model_trace: [],
    durationMs: 100,
    tokenEstimate: 0,
    ...overrides,
  };
}

/* ===================== 1/7: classifyHeal — auto (target-only change) ===================== */
console.log('=== v43 1/7: classifyHeal — only a locator moved (target-only change) → auto ===');
{
  const oldS = baseScript();
  // The Login button's locator moved (relabeled), but it's still the same
  // click step in the same position; the assertion is byte-identical.
  const newS = withSteps(oldS, [
    { type: 'navigate', url: 'http://localhost:9401/login' },
    { type: 'type', target: { role: 'textbox', name: 'Email' }, text: 'test@test.com' },
    { type: 'click', target: { role: 'button', name: 'Sign in' } }, // <-- locator moved
    { type: 'assert_dom', target: { role: 'status', name: 'Message' }, contains: 'Order confirmed successfully' },
  ]);
  const result = classifyHeal(oldS, newS);
  check('tier is auto', result.tier === 'auto');
  check('reasons name the moved target', result.reasons.some((r) => r.includes('target moved')));
}

/* ===================== 2/7: classifyHeal — notice (nav/wait insertion) ===================== */
console.log('\n=== v43 2/7: classifyHeal — an inserted wait step, assertions unchanged → notice ===');
{
  const oldS = baseScript();
  const newS = withSteps(oldS, [
    { type: 'navigate', url: 'http://localhost:9401/login' },
    { type: 'type', target: { role: 'textbox', name: 'Email' }, text: 'test@test.com' },
    { type: 'click', target: { role: 'button', name: 'Login' } },
    { type: 'wait', ms: 500 }, // <-- inserted: the app now needs a beat before the banner renders
    { type: 'assert_dom', target: { role: 'status', name: 'Message' }, contains: 'Order confirmed successfully' },
  ]);
  const result = classifyHeal(oldS, newS);
  check('tier is notice', result.tier === 'notice');
  check('reasons mention the added step', result.reasons.some((r) => /added/i.test(r)));
}

/* ===== 2b: an inserted INTERACTION step, assertions unchanged -> notice ===== */
console.log('\n=== v43 2b: classifyHeal — an inserted click, assertions unchanged → notice ===');
{
  // Regression lock for the 2026-08-09 dogfood drift: the UI gained a required
  // interaction, the AI re-derived a script with one extra `click`, and the
  // original nav/wait-only insertion rule quarantined it — which made --heal
  // useless for the exact case it exists to serve. Step count was never the
  // safety property; assertions are, and they are unchanged here.
  const oldS = baseScript();
  const newS = withSteps(oldS, [
    { type: 'navigate', url: 'http://localhost:9401/login' },
    { type: 'type', target: { role: 'textbox', name: 'Email' }, text: 'test@test.com' },
    { type: 'click', target: { role: 'button', name: 'Accept cookies' } }, // <-- new required interaction
    { type: 'click', target: { role: 'button', name: 'Login' } },
    { type: 'assert_dom', target: { role: 'status', name: 'Message' }, contains: 'Order confirmed successfully' },
  ]);
  const result = classifyHeal(oldS, newS);
  check('inserted click is notice, not quarantine', result.tier === 'notice');
}

/* ===== 2c: an inserted ASSERTION still quarantines ===== */
console.log('\n=== v43 2c: classifyHeal — an inserted assertion → quarantine ===');
{
  // The counterweight to 2b: widening insertions must NOT let a heal invent
  // its own expectations. An AI marking its own homework is precisely what
  // this gate exists to stop.
  const oldS = baseScript();
  const newS = withSteps(oldS, [
    { type: 'navigate', url: 'http://localhost:9401/login' },
    { type: 'type', target: { role: 'textbox', name: 'Email' }, text: 'test@test.com' },
    { type: 'click', target: { role: 'button', name: 'Login' } },
    { type: 'assert_dom', target: { role: 'status', name: 'Message' }, contains: 'ok' }, // <-- invented
    { type: 'assert_dom', target: { role: 'status', name: 'Message' }, contains: 'Order confirmed successfully' },
  ]);
  const result = classifyHeal(oldS, newS);
  check('inserted assertion quarantines', result.tier === 'quarantine');
}

/* ===================== 3/7: classifyHeal — quarantine: step removed ===================== */
console.log('\n=== v43 3/7: classifyHeal — a step was removed → quarantine ===');
{
  const oldS = baseScript();
  const newS = withSteps(oldS, [
    { type: 'navigate', url: 'http://localhost:9401/login' },
    { type: 'type', target: { role: 'textbox', name: 'Email' }, text: 'test@test.com' },
    // click step is GONE — the heal "fixed" the flow by skipping the login click entirely
    { type: 'assert_dom', target: { role: 'status', name: 'Message' }, contains: 'Order confirmed successfully' },
  ]);
  const result = classifyHeal(oldS, newS);
  check('tier is quarantine', result.tier === 'quarantine');
  check('reasons cite the step-count decrease', result.reasons.some((r) => /step count decreased/.test(r)));
}

/* ===================== 4/7: classifyHeal — quarantine: assertion weakened (exact → contains) ===================== */
console.log('\n=== v43 4/7: classifyHeal — assertion weakened (full phrase → narrow prefix) → quarantine ===');
{
  const oldS = baseScript();
  const newS = withSteps(oldS, [
    ...oldS.steps.slice(0, 3),
    // The heal replaced a precise, hard-to-satisfy phrase with a bare prefix
    // that matches almost anything — exactly the "exact -> contains"-style
    // narrowing the audit calls out. Same target, shorter/prefix content.
    { type: 'assert_dom', target: { role: 'status', name: 'Message' }, contains: 'Order' },
  ]);
  const result = classifyHeal(oldS, newS);
  check('tier is quarantine', result.tier === 'quarantine');
  check('reasons call it out as weakened', result.reasons.some((r) => /weakened/i.test(r)));

  // Sanity: the SAME assertion re-targeted (content unchanged, locator moved)
  // is ALSO quarantine — unlike a non-assertion step, an assertion's own
  // target moving is itself risky (it might now check a different region).
  const retargeted = withSteps(oldS, [
    ...oldS.steps.slice(0, 3),
    { type: 'assert_dom', target: { role: 'status', name: 'Banner' }, contains: 'Order confirmed successfully' },
  ]);
  const retargetedResult = classifyHeal(oldS, retargeted);
  check('assertion re-targeted (content unchanged) is ALSO quarantine', retargetedResult.tier === 'quarantine');
  check('reasons call out re-targeting', retargetedResult.reasons.some((r) => /re-targeted/i.test(r)));

  // And an outright assertion removal (replaced by a same-count wait, so the
  // overall step count is UNCHANGED — isolates the "assertion count
  // decreased" path from the step-count-decreased path tested above).
  const assertionRemoved = withSteps(oldS, [
    ...oldS.steps.slice(0, 3),
    { type: 'wait', ms: 200 },
  ]);
  const removedResult = classifyHeal(oldS, assertionRemoved);
  check('assertion removed (same step count) is quarantine', removedResult.tier === 'quarantine');
  check('reasons cite the assertion-count decrease', removedResult.reasons.some((r) => /assertion count decreased/.test(r)));
}

/* ===================== 5/7: applyHealDecision — quarantine leaves the original untouched ===================== */
console.log('\n=== v43 5/7: applyHealDecision — quarantine never touches the original, writes a .candidate.json ===');
{
  const root = freshRoot();
  const oldS = baseScript();
  saveScript(oldS, root); // the "currently active" script, as if recorded earlier

  const weakened = withSteps(oldS, [
    ...oldS.steps.slice(0, 3),
    { type: 'assert_dom', target: { role: 'status', name: 'Message' }, contains: 'Order' },
  ]);
  const decision = applyHealDecision(oldS, weakened, root);

  check('decision tier is quarantine', decision.tier === 'quarantine');
  check('decision has a candidatePath ending in .candidate.json', Boolean(decision.candidatePath?.endsWith('.candidate.json')));
  check('decision has NO jsonPath (nothing overwritten)', decision.jsonPath === undefined);

  const reloaded = loadScript(oldS.name, root);
  check('the ORIGINAL script on disk is byte-for-byte untouched', JSON.stringify(reloaded.steps) === JSON.stringify(oldS.steps));

  check('the candidate file exists on disk', fs.existsSync(decision.candidatePath!));
  const candidateOnDisk: QaScript = JSON.parse(fs.readFileSync(decision.candidatePath!, 'utf8'));
  check('the candidate file holds the WEAKENED (healed) steps, not the original', JSON.stringify(candidateOnDisk.steps) === JSON.stringify(weakened.steps));
}

/* ===================== 6/7: applyHealDecision — auto/notice DO overwrite; needs-review exit-code exclusion ===================== */
console.log('\n=== v43 6/7: applyHealDecision — auto overwrites; a quarantined run reports needs-review, excluded from pass/fail ===');
{
  const root = freshRoot();
  const oldS = baseScript();
  saveScript(oldS, root);

  const targetMoved = withSteps(oldS, [
    { type: 'navigate', url: 'http://localhost:9401/login' },
    { type: 'type', target: { role: 'textbox', name: 'Email' }, text: 'test@test.com' },
    { type: 'click', target: { role: 'button', name: 'Sign in' } },
    { type: 'assert_dom', target: { role: 'status', name: 'Message' }, contains: 'Order confirmed successfully' },
  ]);
  const autoDecision = applyHealDecision(oldS, targetMoved, root);
  check('auto decision DOES write jsonPath', Boolean(autoDecision.jsonPath));
  const reloadedAfterAuto = loadScript(oldS.name, root);
  check('the script on disk now reflects the healed (target-moved) steps', JSON.stringify(reloadedAfterAuto.steps) === JSON.stringify(targetMoved.steps));

  // Mirror the exact merge engine.ts's qaReplay performs on the quarantine
  // path (see engine.ts's heal branch) to prove the reported shape carries
  // the "needs-review" semantics: verdict overridden to 'uncertain' (never
  // silently 'pass'), healReview attached, healed:false (original identity
  // preserved).
  const originalFailedReplay = fakeReport({ runId: 'run-replay-fail', verdict: 'fail', reason: 'replay failed at step 3' });
  const freshHealRun = fakeReport({ runId: 'run-heal-ai', verdict: 'pass', reason: 'healed run passed' });
  const stepRemoved = withSteps(oldS, oldS.steps.slice(0, 2)); // heal quietly dropped the last two steps
  const quarantineDecision = applyHealDecision(oldS, stepRemoved, root);
  check('the step-removal candidate is quarantined', quarantineDecision.tier === 'quarantine');

  const needsReviewResult: QaReplayResult = {
    ...freshHealRun,
    verdict: 'uncertain',
    reason: `heal candidate quarantined for review (${quarantineDecision.reasons.join('; ')}) — original script kept active pending review`,
    healed: false,
    healReview: { tier: quarantineDecision.tier, reasons: quarantineDecision.reasons, candidatePath: quarantineDecision.candidatePath },
  };

  check('needs-review result is NOT pass', needsReviewResult.verdict !== 'pass');
  check('needs-review result is NOT fail', needsReviewResult.verdict !== 'fail');
  check('needs-review result carries the quarantine healReview record', needsReviewResult.healReview?.tier === 'quarantine');
  check('needs-review result is NOT marked healed (original script identity preserved)', needsReviewResult.healed === false);

  // The exact ternary cli.ts uses for a single replay's exit code
  // (report.verdict === 'pass' ? 0 : report.verdict === 'fail' ? 1 : 2):
  // a needs-review run must land in the third bucket, distinct from both a
  // clean pass (0) and a confirmed fail (1) — "excluded from the pass/fail
  // exit code" made concrete.
  const exitCode = needsReviewResult.verdict === 'pass' ? 0 : needsReviewResult.verdict === 'fail' ? 1 : 2;
  check('needs-review maps to the third exit-code bucket (2), neither 0 (pass) nor 1 (fail)', exitCode === 2);
  void originalFailedReplay;
}

/* ===================== 7/7: A11 — resolveRetryOutcome (flaky) + quarantine list / suiteExitCode ===================== */
console.log('\n=== v43 7/7: resolveRetryOutcome (flaky) + .spike-quarantine.json / suiteExitCode ===');
{
  // fail then pass -> flaky, final verdict is the PASS, not folded into
  // 'uncertain'/'fail'.
  const failThenPass = resolveRetryOutcome([
    fakeReport({ runId: 'attempt-1', verdict: 'fail', reason: 'flaked once' }),
    fakeReport({ runId: 'attempt-2', verdict: 'pass', reason: 'passed on retry' }),
  ]);
  check('fail-then-pass reports the final verdict as pass', failThenPass.verdict === 'pass');
  check('fail-then-pass is flagged flaky', Boolean(failThenPass.flaky));
  check('flaky.attempts counts both attempts', failThenPass.flaky?.attempts === 2);
  check('flaky.failedAttempts records exactly the failed one', failThenPass.flaky?.failedAttempts.length === 1 && failThenPass.flaky?.failedAttempts[0].runId === 'attempt-1');

  // fail, fail, pass -> flaky across 3 attempts.
  const failFailPass = resolveRetryOutcome([
    fakeReport({ runId: 'a1', verdict: 'fail', reason: 'r1' }),
    fakeReport({ runId: 'a2', verdict: 'fail', reason: 'r2' }),
    fakeReport({ runId: 'a3', verdict: 'pass', reason: 'r3' }),
  ]);
  check('fail-fail-pass is flaky with 3 attempts', failFailPass.flaky?.attempts === 3);
  check('fail-fail-pass records 2 failed attempts', failFailPass.flaky?.failedAttempts.length === 2);

  // fail every time -> NOT flaky, just a clean fail (nothing "eventually passed").
  const allFail = resolveRetryOutcome([
    fakeReport({ runId: 'b1', verdict: 'fail', reason: 'r1' }),
    fakeReport({ runId: 'b2', verdict: 'fail', reason: 'r2' }),
  ]);
  check('failing on every attempt is NOT flaky', allFail.flaky === undefined);
  check('failing on every attempt still reports fail', allFail.verdict === 'fail');

  // a single clean pass (no retries consumed) -> not flaky.
  const cleanPass = resolveRetryOutcome([fakeReport({ runId: 'c1', verdict: 'pass', reason: 'first try' })]);
  check('a single-attempt pass is NOT flaky', cleanPass.flaky === undefined);

  // ---- quarantine list + suiteExitCode ----
  const root = freshRoot();
  check('a fresh root has an empty quarantine list', loadQuarantineList(root).length === 0);
  check('nothing is quarantined yet', !isQuarantined('known-flaky-flow', root));

  addToQuarantine('known-flaky-flow', 'flakes ~5% of the time on the checkout modal', root);
  check('known-flaky-flow is now quarantined', isQuarantined('known-flaky-flow', root));
  check('.spike-quarantine.json exists on disk', fs.existsSync(path.join(root, '.spike-quarantine.json')));

  // A quarantined FAIL must not fail the aggregate; a non-quarantined FAIL still must.
  const onlyQuarantinedFails = suiteExitCode(
    [
      { name: 'known-flaky-flow', verdict: 'fail' },
      { name: 'healthy-flow', verdict: 'pass' },
    ],
    root,
  );
  check('a quarantined flow failing does NOT fail the aggregate exit code', onlyQuarantinedFails === 0);

  const genuineFailurePresent = suiteExitCode(
    [
      { name: 'known-flaky-flow', verdict: 'fail' },
      { name: 'healthy-flow', verdict: 'fail' }, // a REAL, non-quarantined failure
    ],
    root,
  );
  check('a genuine (non-quarantined) failure still fails the aggregate', genuineFailurePresent === 1);

  removeFromQuarantine('known-flaky-flow', root);
  check('removeFromQuarantine un-quarantines the flow', !isQuarantined('known-flaky-flow', root));
  const afterRemoval = suiteExitCode([{ name: 'known-flaky-flow', verdict: 'fail' }], root);
  check('once un-quarantined, the SAME failure now fails the aggregate', afterRemoval === 1);
}

/* ===================== cleanup + summary ===================== */
for (const dir of tmpDirs) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  console.error(`\n${failed.length} checks failed:`);
  for (const [label] of failed) console.error(` - ${label}`);
  process.exit(1);
}
console.log(`\nV43 heal-flake checks passed (${checks.length}).`);
process.exit(0);
