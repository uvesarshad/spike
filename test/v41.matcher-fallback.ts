/* v41 — A10 (P1): replay matcher robustness + loud, machine-readable fallback.
 *
 * The audit (docs/plan/26-08-08-audit-deterministic-speed.md, A10) found two
 * silent failure modes in the Phase 14 pre-run replay matcher:
 *
 *   1. `matchReplayScript` scored a pure bag-of-words Jaccard similarity with
 *      no stemming — reword a task ("logs in" vs "log in") and the score
 *      could drop below the 0.62 threshold with NO indication a near-miss
 *      script existed, silently buying a full-price AI run.
 *   2. When a matched script replays to `fail`, `qaRun` fell back to a fresh
 *      AI pass with the fallback visible only via `onProgress` — invisible to
 *      any `--json`/MCP/programmatic caller.
 *
 * This suite covers the fix, entirely at the unit level (no browser):
 *   1. an exact task+url match scores comfortably above threshold;
 *   2. a reworded-but-equivalent task scores HIGHER thanks to stemming than
 *      the old bag-of-words-only scoring would have (explicit before/after);
 *   3. a genuinely different task stays below threshold;
 *   4. a near-miss (sub-threshold but close) is reported via
 *      `matchReplayScriptDetailed`'s `bestCandidate`, and engine.ts's
 *      `nearMissMessage()` turns it into a progress line;
 *   5. the host hard-gate still rejects a different host, AND a different
 *      port on the same localhost host;
 *   6. `buildReplayFallback()` (the pure helper engine.ts's qaRun uses when a
 *      matched replay comes back `fail`/errors) produces a `replayFallback`
 *      field that survives being spread onto a report-shaped object — the
 *      same "attach + re-persist" pattern qaRun uses, exercised here by
 *      stubbing/faking the replay outcome instead of driving a real browser.
 *
 * Run: npx tsx test/v41.matcher-fallback.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  matchReplayScript,
  matchReplayScriptDetailed,
  tokenize,
  jaccard,
  DEFAULT_THRESHOLD,
  NEAR_MISS_MARGIN,
  type ReplayMatch,
} from '../src/recorder/matcher.js';
import { buildReplayFallback, nearMissMessage, type QaRunResult } from '../src/engine.js';
import { saveScript, type QaScript } from '../src/recorder/script.js';
import type { Report } from '../src/report/report.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

/* ===================== fixtures ===================== */

let root: string;
function freshRoot(): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'v41-matcher-'));
  return root;
}

function fixtureScript(overrides: Partial<QaScript>): QaScript {
  return {
    version: 1,
    name: overrides.name ?? 'fixture-script',
    task: overrides.task ?? 'do the thing',
    url: overrides.url ?? 'http://localhost:9401/start',
    sourceRunId: 'run-fixture',
    createdAt: new Date().toISOString(),
    steps: [{ type: 'navigate', url: overrides.url ?? 'http://localhost:9401/start' }],
    ...overrides,
  };
}

/** Pre-A10 bag-of-words-only scoring (no stemming), reimplemented locally
 * from the SAME stopword list the shipped matcher uses, purely to compute a
 * "before" baseline for the stemming-improvement assertion below. This is
 * intentionally a standalone copy — it must NOT import any matcher internals
 * that themselves changed, or the "before" number stops meaning anything. */
const OLD_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have',
  'in', 'into', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'then', 'this',
  'to', 'with', 'should', 'must', 'end', 'page', 'goes', 'go', 'using', 'via', 'onto',
]);
function oldTokenize(task: string): Set<string> {
  return new Set(
    task
      .toLowerCase()
      .replace(/\{\{[^}]+\}\}/g, ' ')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !OLD_STOPWORDS.has(w)),
  );
}
function oldJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/* ===================== 1/6: exact match scores above threshold ===================== */
console.log('=== v41 1/6: exact task+url match scores comfortably above threshold ===');
{
  const dir = freshRoot();
  const task = 'log in as test@test.com and add the widget to the cart';
  const url = 'http://localhost:9401/login';
  saveScript(fixtureScript({ name: 'exact-match', task, url }), dir);

  const match = matchReplayScript(task, url, { dir });
  check('exact task+url match is found', match !== null);
  check('exact match scores 1.0 (identical task text + identical path)', match !== null && match.score === 1);

  fs.rmSync(dir, { recursive: true, force: true });
}

/* ===================== 2/6: stemming improves a reworded-but-equivalent task ===================== */
console.log('\n=== v41 2/6: reworded task scores higher thanks to stemming (explicit before/after) ===');
{
  const dir = freshRoot();
  const recordedTask = 'User logs in and checks out the cart';
  const rewordedTask = 'user log in and check out cart'; // same meaning, inflection dropped
  const url = 'http://localhost:9401/checkout';
  saveScript(fixtureScript({ name: 'login-checkout', task: recordedTask, url }), dir);

  // "before": what the pre-A10 bag-of-words-only scorer would have produced
  // for the TASK-SIMILARITY component alone (0.7 weight), combined with a
  // perfect path match (0.3 weight, since both point at the same URL) — this
  // reproduces the exact combined-score formula matcher.ts uses.
  const beforeTaskSim = oldJaccard(oldTokenize(recordedTask), oldTokenize(rewordedTask));
  const beforeCombined = 0.7 * beforeTaskSim + 0.3 * 1;

  // "after": the real, shipped matcher (with stemming) scoring the same pair.
  const afterTaskSim = jaccard(tokenize(recordedTask), tokenize(rewordedTask));
  const afterMatch = matchReplayScript(rewordedTask, url, { dir });
  const afterCombined = afterMatch?.score ?? 0.7 * afterTaskSim + 0.3 * 1;

  console.log(`  before (no stemming): taskSim=${beforeTaskSim.toFixed(3)} combined=${beforeCombined.toFixed(3)}`);
  console.log(`  after  (stemming):    taskSim=${afterTaskSim.toFixed(3)} combined=${afterCombined.toFixed(3)}`);

  check('stemming strictly improves task similarity for the reworded pair', afterTaskSim > beforeTaskSim);
  check('stemming strictly improves the combined score', afterCombined > beforeCombined);
  check(
    'the improvement crosses the threshold: old scoring would have missed this pair, new scoring matches it',
    beforeCombined < DEFAULT_THRESHOLD && afterCombined >= DEFAULT_THRESHOLD,
  );
  check('matchReplayScript finds the reworded task against the real matcher', afterMatch !== null && afterMatch.name === 'login-checkout');

  fs.rmSync(dir, { recursive: true, force: true });
}

/* ===================== 3/6: genuinely different task stays below threshold ===================== */
console.log('\n=== v41 3/6: a genuinely different task on the same host stays below threshold ===');
{
  const dir = freshRoot();
  const url = 'http://localhost:9401/account';
  saveScript(fixtureScript({ name: 'reset-password', task: 'reset the account password via the email link', url }), dir);

  const differentUrl = 'http://localhost:9401/other';
  const match = matchReplayScript('delete the account and confirm the goodbye screen', differentUrl, { dir });
  check('an unrelated task does not match despite sharing a host', match === null);

  fs.rmSync(dir, { recursive: true, force: true });
}

/* ===================== 4/6: near-miss is surfaced, not silently dropped ===================== */
console.log('\n=== v41 4/6: a near-miss candidate is surfaced via bestCandidate + nearMissMessage ===');
{
  const dir = freshRoot();
  const url = 'http://localhost:9401/checkout';
  // Same vocabulary as the stemming case above, diluted with enough extra
  // unrelated words that taskSim (and so the combined score) lands strictly
  // between (threshold - NEAR_MISS_MARGIN) and threshold — a genuine
  // near-miss on disk, verified below to score ~0.52 against a 0.62
  // threshold / 0.47 floor, not a match.
  const recordedTask =
    'User logs in and checks out the cart with a coupon applied at the very end after browsing several unrelated recommended items in a sidebar carousel';
  saveScript(fixtureScript({ name: 'near-miss-script', task: recordedTask, url }), dir);

  const queryTask = 'user log in and check out cart';
  const detailed = matchReplayScriptDetailed(queryTask, url, { dir });
  check('threshold echoed back matches DEFAULT_THRESHOLD when unset', detailed.threshold === DEFAULT_THRESHOLD);
  check('this fixture is a genuine near-miss: no confident match', detailed.matched === null);
  check(
    'bestCandidate score sits below threshold but within NEAR_MISS_MARGIN of it',
    Boolean(detailed.bestCandidate) &&
      detailed.bestCandidate!.score < detailed.threshold &&
      detailed.bestCandidate!.score >= detailed.threshold - NEAR_MISS_MARGIN,
  );
  check('bestCandidate names the near-miss script', detailed.bestCandidate?.name === 'near-miss-script');
  const msg = nearMissMessage(detailed.bestCandidate, detailed.threshold);
  check('nearMissMessage() produces a line naming the script and its score for this near-miss', Boolean(msg) && msg!.includes('near-miss-script'));

  // Boundary math, independent of any fixture: exactly at the margin edge is
  // reported; just past it is not.
  const atEdge: ReplayMatch = { name: 'edge', score: DEFAULT_THRESHOLD - NEAR_MISS_MARGIN };
  const pastEdge: ReplayMatch = { name: 'far', score: DEFAULT_THRESHOLD - NEAR_MISS_MARGIN - 0.01 };
  check('a candidate exactly NEAR_MISS_MARGIN below threshold IS reported', nearMissMessage(atEdge, DEFAULT_THRESHOLD) !== null);
  check('a candidate just past NEAR_MISS_MARGIN below threshold is NOT reported', nearMissMessage(pastEdge, DEFAULT_THRESHOLD) === null);
  check('no candidate at all -> no message', nearMissMessage(undefined, DEFAULT_THRESHOLD) === null);

  fs.rmSync(dir, { recursive: true, force: true });
}

/* ===================== 5/6: host hard-gate (different host AND different port) ===================== */
console.log('\n=== v41 5/6: host hard-gate rejects a different host and a different port on localhost ===');
{
  const dir = freshRoot();
  const task = 'log in and check out';
  saveScript(fixtureScript({ name: 'gated-script', task, url: 'http://localhost:9401/login' }), dir);

  const differentHost = matchReplayScript(task, 'http://example.com/login', { dir });
  check('a different host is rejected even with an identical task', differentHost === null);

  const differentPort = matchReplayScript(task, 'http://localhost:3000/login', { dir });
  check('a different PORT on the same localhost hostname is rejected (port is part of the gate)', differentPort === null);

  const sameHostAndPort = matchReplayScript(task, 'http://localhost:9401/login', { dir });
  check('sanity: the same host+port DOES match', sameHostAndPort !== null);

  const wwwSibling = matchReplayScript(task, 'http://www.localhost:9401/login', { dir });
  // www./bare-domain siblings should still be treated as the same host
  // (matcher.ts's bareHost() strips a leading www.) — a regression here means
  // the host gate got stricter than documented, not just "different port".
  check('a www./bare-domain sibling on the SAME port still matches (apex/www tolerance)', wwwSibling !== null);

  fs.rmSync(dir, { recursive: true, force: true });
}

/* ===================== 6/6: replayFallback shape (stubbed replay outcome) ===================== */
console.log('\n=== v41 6/6: replayFallback carries the matched script + stubbed replay outcome ===');
{
  const match: ReplayMatch = { name: 'flaky-script', score: 0.91 };

  const failFallback = buildReplayFallback(match, 'fail', 'replay-failed');
  check('replay-failed fallback carries the matched name/score', failFallback.name === 'flaky-script' && failFallback.score === 0.91);
  check('replay-failed fallback carries the stubbed replay verdict', failFallback.replayVerdict === 'fail');
  check('replay-failed fallback carries its reason', failFallback.reason === 'replay-failed');

  const errorFallback = buildReplayFallback(match, 'uncertain', 'replay-error');
  check('replay-error fallback records verdict as uncertain (no real verdict to report)', errorFallback.replayVerdict === 'uncertain');
  check('replay-error fallback carries its reason', errorFallback.reason === 'replay-error');

  // Mirrors qaRun's own "attach + re-persist" pattern (engine.ts: `result.replayFallback
  // = replayFallback`) against a fake report-shaped object standing in for what
  // runFreshAiPass would actually return — stubbing the replay outcome instead
  // of driving a real browser, per A10's test brief.
  const fakeFreshAiReport: Report = {
    runId: 'run-999',
    task: 'do the thing',
    url: 'http://localhost:9401/start',
    verdict: 'pass',
    failing_step: null,
    console_error: null,
    evidence_paths: ['run-999/screenshot-0.png'],
    reason: 'completed',
    steps: [],
    model_trace: [],
    durationMs: 1234,
    tokenEstimate: 42,
  };
  const result: QaRunResult = { ...fakeFreshAiReport, replayFallback: failFallback };
  check('the report gains a replayFallback field without losing its own fields', result.replayFallback?.name === 'flaky-script' && result.runId === 'run-999' && result.verdict === 'pass');
  check('replayFallback round-trips through JSON (what a --json/MCP/report.json consumer actually reads)', JSON.parse(JSON.stringify(result)).replayFallback?.name === 'flaky-script');
}

/* ===================== summary ===================== */
const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v41 matcher-fallback checks passed`);
process.exit(failed.length ? 1 : 0);
