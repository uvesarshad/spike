/* v131 — A9: `spike ci` summary rendering, exit codes, URL wait, PR comment
 * body. All stubbed: no network, no Chrome, no models. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderCiJunit, renderCiSummary, runCi, waitForUrl, writeCiOutputs, CI_COMMENT_MARKER, type CiResult } from '../src/ci/ci.js';
import { buildPrComment, upsertCommentPlan } from '../src/ci/pr-comment.js';

let bad = 0;
const check = (label: string, ok: boolean) => {
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const okDeps = { fetchStatus: async () => 200, sleep: async () => {} };
const suite = (verdict: 'pass' | 'fail' | 'uncertain') => async () => ({
  verdict,
  passed: verdict === 'pass' ? 2 : 1,
  total: 2,
  tests: [{ test: 'login | flow', verdict: 'fail' as const, reason: 'button missing' }, { test: 'home', verdict: 'pass' as const }],
  summary: '1/2 passed.',
});
const chk = (verdict: 'pass' | 'fail' | 'uncertain') => async () =>
  ({ outcome: { verdict, flows: [], coverage: {} }, findings: [], summary: 'looked at 3 pages', pagesChecked: 3, problems: 0, capped: false }) as never;

(async () => {
  // exit codes from stubbed results
  const pass = await runCi({ url: 'http://x', suite: true, check: true }, { ...okDeps, runSuite: suite('pass'), runCheck: chk('pass') });
  check('pass + pass → exit 0', pass.exitCode === 0 && pass.verdict === 'pass');
  const fail = await runCi({ url: 'http://x', suite: true, check: true }, { ...okDeps, runSuite: suite('fail'), runCheck: chk('pass') });
  check('any fail → exit 1', fail.exitCode === 1);
  const unsure = await runCi({ url: 'http://x', check: true }, { ...okDeps, runCheck: chk('uncertain') });
  check('uncertain → exit 2', unsure.exitCode === 2 && !unsure.suite);
  const none = await runCi({ url: 'http://x' }, okDeps);
  check('nothing selected → exit 3', none.exitCode === 3 && !!none.error);

  // budget is split when both run, whole otherwise
  const seen: (number | undefined)[] = [];
  await runCi({ url: 'http://x', suite: true, check: true, budgetUsd: 2 }, { ...okDeps, runSuite: async (_o, b) => (seen.push(b), suite('pass')()), runCheck: async (_o, b) => (seen.push(b), chk('pass')()) });
  check('budget split across suite and check', seen[0] === 1 && seen[1] === 1);

  // waiting for the URL
  let calls = 0;
  let t = 0;
  await waitForUrl('http://x', { fetchStatus: async () => (++calls < 3 ? 503 : 200), sleep: async (ms) => void (t += ms), now: () => t }, 10_000, 1000);
  check('polls until 200', calls === 3);
  let threw = false;
  await waitForUrl('http://x', { fetchStatus: async () => 502, sleep: async (ms) => void (t += ms), now: () => t }, 5000, 1000).catch(() => (threw = true));
  check('times out when the address never comes up', threw);
  const dead = await runCi({ url: 'http://x', suite: true, waitMs: 1000 }, { fetchStatus: async () => 0, sleep: async (ms) => void (t += ms), now: () => t });
  check('address never up → exit 3 with a reason', dead.exitCode === 3 && /did not answer/.test(dead.error ?? ''));

  // summary
  const md = renderCiSummary(fail);
  check('summary has verdict, table, escaped pipe, spend line', /Failed/.test(md) && /\| Test \| Result/.test(md) && md.includes('login \\| flow') && /button missing/.test(md));
  const r: CiResult = { ...pass, budgetUsd: 2 };
  check('summary shows pages checked and spend cap', /3 pages looked at/.test(renderCiSummary(r)) && /\$2\.00/.test(renderCiSummary(r)));
  check('junit counts failures', /failures="1"/.test(renderCiJunit(fail)));

  // outputs incl. GITHUB_STEP_SUMMARY
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-v131-'));
  writeCiOutputs(fail, { summary: path.join(dir, 's/sum.md'), junit: path.join(dir, 'j.xml'), env: { GITHUB_STEP_SUMMARY: path.join(dir, 'gh.md') } });
  check('summary, junit and step summary written', ['s/sum.md', 'j.xml', 'gh.md'].every((f) => fs.existsSync(path.join(dir, f))));

  // PR comment
  const body = buildPrComment(md, { runUrl: 'https://gh/run/1' });
  check('comment starts with the marker and links the run', body.startsWith(CI_COMMENT_MARKER) && body.includes('https://gh/run/1'));
  check('comment is capped', buildPrComment('x'.repeat(100_000)).length <= 60_000);
  check('no existing comment → create', upsertCommentPlan([{ id: 1, body: 'hi' }]).action === 'create');
  const up = upsertCommentPlan([{ id: 1, body: 'hi' }, { id: 7, body }]);
  check('marked comment → update that one', up.action === 'update' && (up as { id: number }).id === 7);

  process.exit(bad ? 1 : 0);
})();
