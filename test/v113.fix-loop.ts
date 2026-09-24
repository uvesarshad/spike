/* v113 — A6: the fix loop fires on `fail` only, waits for the page to actually
 * rebuild before re-testing, and says so when it could not confirm. All with
 * stub fetch/sleep/agent/run — no network, no clock, no Chrome. */
import { runWithAutoFix } from '../src/vibe/auto-fix.js';
import { fingerprintTarget, referencedAssets, waitForRebuild, isLocalTarget, UNCONFIRMED_REBUILD_NOTE, type FetchLike } from '../src/vibe/rebuild-wait.js';
import type { QaRunResult } from '../src/engine.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const rep = (verdict: 'pass' | 'fail' | 'uncertain'): QaRunResult =>
  ({ runId: 'r', task: 't', url: 'u', verdict, reason: `was ${verdict}`, steps: [], evidence_paths: [] }) as unknown as QaRunResult;

/** A page whose HTML/asset bodies come from a mutable table; counts calls. */
function fakeSite(bodies: () => Record<string, string>) {
  let calls = 0;
  const fetchFn: FetchLike = async (url) => {
    calls++;
    const b = bodies()[url];
    if (b === undefined) return { status: 404, text: async () => '' };
    return { status: 200, text: async () => b };
  };
  return { fetchFn, calls: () => calls };
}
function clock() {
  let t = 0;
  return { nowFn: () => t, sleepFn: async (ms: number) => { t += ms; } };
}

(async () => {
  // --- helpers
  check('localhost detected', isLocalTarget('http://localhost:3000/x') && isLocalTarget('http://127.0.0.1/') && !isLocalTarget('https://app.example.com'));
  const html = '<link rel="stylesheet" href="/a.css"><script src="/b.js"></script><script src="https://cdn.x/y.js"></script>';
  check('same-origin assets only', referencedAssets(html, 'https://app.example.com/').sort().join() === 'https://app.example.com/a.css,https://app.example.com/b.js');

  // --- fingerprint changes when an asset changes even if the HTML does not
  let jsBody = 'v1';
  const site = fakeSite(() => ({ 'https://app.example.com/': html, 'https://app.example.com/a.css': 'c', 'https://app.example.com/b.js': jsBody }));
  const f1 = await fingerprintTarget('https://app.example.com/', site.fetchFn);
  jsBody = 'v2';
  const f2 = await fingerprintTarget('https://app.example.com/', site.fetchFn);
  check('fingerprint sees a changed script', f1 !== null && f1 !== f2);

  // --- remote target: changes on the 3rd poll => re-test only after it
  let polls = 0;
  const changing: FetchLike = async () => {
    polls++;
    return { status: 200, text: async () => (polls >= 3 ? 'new' : 'old') };
  };
  const before = await fingerprintTarget('https://app.example.com/', changing); // poll 1 = 'old'
  polls = 0;
  const c1 = clock();
  const seenAt: number[] = [];
  const res = await waitForRebuild('https://app.example.com/', before, {
    fetchFn: async (u) => { const r = await changing(u); seenAt.push(c1.nowFn()); return r; },
    ...c1, pollMs: 3000, timeoutMs: 180_000,
  });
  check('confirmed once the page changed (3rd poll)', res.confirmed === true && polls === 3);
  check('waited ~3 polls of 3s', c1.nowFn() === 9000);

  // --- never changes => timeout note
  const c2 = clock();
  const sameFetch: FetchLike = async () => ({ status: 200, text: async () => 'x' });
  const same = await waitForRebuild('https://app.example.com/', await fingerprintTarget('https://app.example.com/', sameFetch), {
    fetchFn: sameFetch, ...c2, pollMs: 3000, timeoutMs: 12_000,
  });
  check('timeout => not confirmed with a note', same.confirmed === false && same.note === UNCONFIRMED_REBUILD_NOTE);

  // --- localhost: grace only, no polling
  const c3 = clock();
  let localFetches = 0;
  const local = await waitForRebuild('http://localhost:3000/', null, {
    fetchFn: async () => { localFetches++; return { status: 200, text: async () => '' }; }, ...c3,
  });
  check('localhost waits the grace then goes', local.confirmed && c3.nowFn() === 3000 && localFetches === 0);

  // --- waitForUrl overrides: polls until 200
  let n = 0;
  const c4 = clock();
  const wf = await waitForRebuild('http://localhost:3000/', null, {
    waitForUrl: 'https://app.example.com/health',
    fetchFn: async () => ({ status: ++n >= 3 ? 200 : 503, text: async () => '' }), ...c4, pollMs: 1000,
  });
  check('waitForUrl polls until 200', wf.confirmed && n === 3);

  // --- loop: uncertain + fix dispatches nothing
  let dispatched = 0;
  const dispatchFn = async () => { dispatched++; return { ok: true, agent: 'stub' }; };
  let runs = 0;
  const uncertainRun = async () => { runs++; return rep('uncertain'); };
  const u = await runWithAutoFix('t', 'http://localhost:1/', { maxAttempts: 2, runFn: uncertainRun as never, dispatchFn, rebuild: { graceMs: 0 } });
  check('uncertain dispatches nothing', dispatched === 0 && runs === 1 && u.attempts[0].fixed === false);
  const u2 = await runWithAutoFix('t', 'http://localhost:1/', { maxAttempts: 2, runFn: uncertainRun as never, dispatchFn, fixOnUncertain: true, rebuild: { graceMs: 0 } });
  check('--fix-on-uncertain opts back in', dispatched === 1 && u2.attempts[0].fixed === true);

  // --- loop: remote target that never rebuilds => note on the report
  dispatched = 0;
  const c5 = clock();
  const seq = ['fail', 'fail'] as const;
  let k = 0;
  const stuck = await runWithAutoFix('t', 'https://app.example.com/', {
    maxAttempts: 2, dispatchFn, runFn: (async () => rep(seq[k++])) as never,
    rebuild: { fetchFn: async () => ({ status: 200, text: async () => 'same' }), ...c5, pollMs: 3000, timeoutMs: 9000 },
  });
  check('never-rebuilt target: re-tested anyway', k === 2 && dispatched === 1);
  check('report says the result may be for the old version', stuck.finalReport.reason.includes(UNCONFIRMED_REBUILD_NOTE) && stuck.rebuildNote === UNCONFIRMED_REBUILD_NOTE);

  // --- loop: rebuilt target => no note
  const c6 = clock();
  let bodyV = 'old';
  const seq2 = ['fail', 'pass'] as const;
  let k2 = 0;
  const okRun = await runWithAutoFix('t', 'https://app.example.com/', {
    maxAttempts: 2, dispatchFn,
    runFn: (async () => rep(seq2[k2++])) as never,
    rebuild: {
      fetchFn: async () => ({ status: 200, text: async () => bodyV }),
      nowFn: c6.nowFn, sleepFn: async (ms) => { await c6.sleepFn(ms); bodyV = 'new'; }, pollMs: 3000, timeoutMs: 9000,
    },
  });
  check('rebuilt target: passes with no stale note', okRun.finalReport.verdict === 'pass' && !okRun.rebuildNote && !okRun.finalReport.reason.includes('old version'));

  // --- initialReport skips the first run (panel path)
  let r3 = 0;
  const panel = await runWithAutoFix('t', 'http://localhost:1/', {
    maxAttempts: 2, initialReport: rep('fail'), dispatchFn, runFn: (async () => { r3++; return rep('pass'); }) as never, rebuild: { graceMs: 0 },
  });
  check('initialReport: one re-run, attempts=2, pass', r3 === 1 && panel.attempts.length === 2 && panel.finalReport.verdict === 'pass');

  if (checks.some(([, ok]) => !ok)) process.exit(1);
})();
