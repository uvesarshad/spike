/* v130 — A7: schedule parser + job store + scheduler tick + watch + notify + map --run-changed. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseWhen, nextDue, isDue } from '../src/schedule/when.js';
import { JobStore } from '../src/schedule/store.js';
import { tick } from '../src/schedule/scheduler.js';
import { isStatusFlip, desktopNotifyCommand, notifyIfFlipped } from '../src/schedule/notify.js';
import { WatchController, shouldIgnore, globToRegex } from '../src/schedule/watch.js';
import { jobArgs } from '../src/schedule/job-runner.js';
import { changedTargets, runChangedPages } from '../src/discovery/run-changed.js';
import type { AppModel } from '../src/discovery/app-model.js';
import type { AppModelDiff } from '../src/discovery/diff.js';

let failed = 0;
const check = (label: string, ok: boolean) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed++; };
const throws = (f: () => unknown) => { try { f(); return false; } catch { return true; } };

// --- parser
check('every 30m', (parseWhen('every 30m') as { ms: number }).ms === 30 * 60_000);
check('every 2h', (parseWhen('Every 2h') as { ms: number }).ms === 2 * 3_600_000);
check('hourly', (parseWhen('hourly') as { ms: number }).ms === 3_600_000);
check('weekdays 09:30', JSON.stringify(parseWhen('weekdays 09:30')) === JSON.stringify({ type: 'daily', hour: 9, minute: 30, weekdaysOnly: true }));
check('rejects junk / 25:00 / every 1m', throws(() => parseWhen('whenever')) && throws(() => parseWhen('daily 25:00')) && throws(() => parseWhen('every 1m')));

// --- next-due + sleep/wake (local time throughout)
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const job = { when: 'every 30m', createdAt: at(2026, 9, 21, 8, 0), lastRunAt: at(2026, 9, 21, 8, 0) };
check('interval not due early', !isDue(job, at(2026, 9, 21, 8, 29)));
check('interval due at +30m', isDue(job, at(2026, 9, 21, 8, 30)));
const daily = { when: 'daily 09:00', createdAt: at(2026, 9, 21, 10, 0), lastRunAt: null };
check('daily next slot is tomorrow when created after it', nextDue(daily, 0) === at(2026, 9, 22, 9, 0));
const wk = { when: 'weekdays 09:00', createdAt: at(2026, 9, 25, 10, 0), lastRunAt: null }; // Fri 2026-09-25
check('weekdays skips the weekend', nextDue(wk, 0) === at(2026, 9, 28, 9, 0));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-sched-'));
try {
  const store = new JobStore({ home });
  let clock = at(2026, 9, 21, 8, 0);
  const j = store.add({ target: 'tag:smoke', url: 'http://x.test', when: 'every 30m', budgetUsd: 1 }, clock);
  check('store file is 0600', process.platform === 'win32' || (fs.statSync(store.file).mode & 0o777) === 0o600);
  check('add/list round-trip', store.list().length === 1 && store.list()[0].kind === 'tag' && store.list()[0].target === 'smoke');
  check('bad target rejected', throws(() => store.add({ target: 'nonsense', url: 'u', when: 'hourly' })));
  check('bad when rejected', throws(() => store.add({ target: 'check', url: 'u', when: 'nope' })));
  const c = store.add({ target: 'check', url: 'http://y.test', when: 'hourly' }, clock);

  // --- tick: sleep then wake runs once, serially, exact due jobs
  const order: string[] = [];
  let inFlight = 0; let maxInFlight = 0;
  const run = async (jb: { id: string }) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    order.push(jb.id);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return { verdict: 'pass' as const, costUsd: 0.25 };
  };
  const notified: unknown[] = [];
  const deps = { store, run, now: () => clock, notify: async (...a: unknown[]) => { notified.push(a); } };
  clock = at(2026, 9, 21, 8, 10);
  check('tick before due runs nothing', (await tick(deps)).length === 0);
  clock = at(2026, 9, 21, 8, 30);
  check('tick runs only the due job', JSON.stringify(await tick(deps)) === JSON.stringify([j.id]));
  clock = at(2026, 9, 24, 8, 0); // laptop slept 3 days
  const ran = await tick(deps);
  check('wake runs each due job exactly once, serially', ran.length === 2 && maxInFlight === 1);
  check('no backlog: immediate second tick runs nothing', (await tick(deps)).length === 0);
  check('spend + verdict recorded', store.get(j.id)!.spentTodayUsd === 0.25 && store.get(j.id)!.lastVerdict === 'pass');
  void c; void order;

  // budget cap stops the job as uncertain
  store.update(j.id, { spentTodayUsd: 1, spendDay: '2026-09-25', lastRunAt: at(2026, 9, 25, 0, 0) });
  clock = at(2026, 9, 25, 1, 0);
  const before = order.length;
  await tick(deps);
  check('budget reached → uncertain, runner not called', store.get(j.id)!.lastVerdict === 'uncertain' && !order.slice(before).includes(j.id));

  check('remove', store.remove(j.id) && !store.remove(j.id) && store.list().length === 1);
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

// --- job args (real runner argv, no spawn)
check('job argv', jobArgs({ kind: 'tag', target: 'smoke' } as never).join(' ').startsWith('suite --tag smoke') && jobArgs({ kind: 'check', url: 'http://a' } as never)[1] === 'http://a');

// --- watch controller with fake timers
{
  let pending: (() => void) | null = null;
  let runs = 0;
  let release: (() => void) | null = null;
  const wc = new WatchController({
    debounceMs: 3000,
    setTimer: (fn) => { pending = fn; return 1; },
    clearTimer: () => { pending = null; },
    run: () => { runs++; return new Promise<void>((r) => { release = r; }); },
  });
  for (let i = 0; i < 10; i++) wc.event();
  (pending as (() => void) | null)?.();
  check('burst of 10 events → 1 run', runs === 1);
  wc.event(); (pending as (() => void) | null)?.(); // change mid-run
  wc.event(); (pending as (() => void) | null)?.(); // another mid-run change
  (release as (() => void) | null)?.();
  await new Promise((r) => setTimeout(r, 5));
  check('change during run → exactly 1 follow-up', runs === 2);
  (release as (() => void) | null)?.();
  await wc.idle();
  check('then idle', runs === 2);
}
check('ignores node_modules/.git/dist/build/artifacts/.spike*', ['node_modules/a.js', 'x/.git/HEAD', 'dist/a', 'build/a', 'artifacts/r/report.json', '.spike-cache/a'].every(shouldIgnore) && !shouldIgnore('src/app.ts'));
check('glob', globToRegex('src/**/*.ts').test('src/a/b.ts') && !globToRegex('src/*.ts').test('src/a/b.ts'));

// --- notifications
check('flip detection', isStatusFlip('pass', 'fail') && isStatusFlip('fail', 'pass') && !isStatusFlip('pass', 'pass') && !isStatusFlip(null, 'fail') && !isStatusFlip('pass', 'uncertain'));
check('argv per OS', desktopNotifyCommand('darwin', 't', 'b')!.file === 'osascript' && desktopNotifyCommand('linux', 't', 'b')!.file === 'notify-send' && desktopNotifyCommand('win32', 't', 'b')!.file === 'powershell' && desktopNotifyCommand('freebsd', 't', 'b') === null);
{
  const calls: string[] = []; const hooks: string[] = [];
  const deps = { platform: 'linux' as const, runner: (f: string) => { calls.push(f); }, fetchFn: async (u: string) => { hooks.push(u); } };
  const ch = { job: 'j', verdict: 'fail' as const, url: 'u', summary: 's' };
  check('no call on unchanged verdict', !(await notifyIfFlipped('fail', ch, 'http://h', deps)) && calls.length === 0 && hooks.length === 0);
  check('flip fires desktop + webhook', (await notifyIfFlipped('pass', ch, 'http://h', deps)) && calls.length === 1 && hooks.length === 1);
}

// --- map --run-changed
{
  const route = (r: string) => ({ route: r, states: [], exercised: false, coveredByScripts: [] }) as never;
  const model = { routes: [route('http://a.test/'), route('http://a.test/new'), route('http://a.test/chg'), route('http://a.test/same')] } as unknown as AppModel;
  const ent = (r: string, kind: string) => ({ route: r, kind, hasCoverage: false });
  const diff = { newRoutes: [ent('http://a.test/new', 'new-route')], changedRoutes: [ent('http://a.test/chg', 'changed-route')], removedRoutes: [ent('http://a.test/gone', 'removed-route')], unchangedRoutes: [], prioritized: [] } as unknown as AppModelDiff;
  const seen: string[][] = [];
  const out = await runChangedPages(model, diff, 'http://a.test/', async (t) => { seen.push(t.map((x) => x.url)); return 'ok'; });
  check('--run-changed checks exactly the changed routes', out.result === 'ok' && seen[0].length === 2 && seen[0].every((u) => /\/(new|chg)$/.test(u)));
  check('nothing changed → checker not called', (await runChangedPages(model, { ...diff, newRoutes: [], changedRoutes: [] }, 'http://a.test/', async () => 'x')).result === null && changedTargets(model, diff, 'http://a.test/').length === 2);
}

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
