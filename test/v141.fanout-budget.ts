/* v141 — A8: batch budget in the fan-out; A11: log in once per batch. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFanOut, renderFlowTable, runOptionsFromContext, type FanOutContext } from '../src/orchestrator/fan-out.js';
import { SpendBudget, parseBudgetFlag, resolveUnattendedBudget, spendSince } from '../src/orchestrator/budget.js';

let failed = 0;
const check = (label: string, ok: boolean) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed++; };
const flows = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `f${i + 1}`, task: `task ${i + 1}` }));
const costly = (usd: number, ctxs?: FanOutContext[]) => async (_f: unknown, _i: number, ctx: FanOutContext) => {
  ctxs?.push(ctx);
  return { verdict: 'pass' as const, spendSummary: { estimatedUsd: usd, paidCalls: 2, freeCalls: 0 } };
};

// --- cap reached before the third flow
{
  const ctxs: FanOutContext[] = [];
  const out = await runFanOut(flows(3), { runFlow: costly(0.4, ctxs), budgetUsd: 0.8 });
  check('third flow skipped once the cap is reached', out.flows.length === 3 && out.flows[2].verdict === 'uncertain');
  check('skip reason names the limit', out.flows[2].reason === 'stopped: spending limit reached ($0.80 of $0.80)');
  check('batch ends uncertain', out.verdict === 'uncertain');
  check('only two flows attempted', out.coverage.flowsAttempted === 2 && out.coverage.flowsTotal === 3);
  check('spend totals reported', Math.abs((out.spend?.estimatedUsd ?? 0) - 0.8) < 1e-9 && out.spend?.paidCalls === 4);
  check('table shows spend line', renderFlowTable(out).includes('Spent about $0.80 of your $0.80 limit'));
}
// --- remaining budget is handed to each run as its per-run cap; runaway flow stops the rest
{
  const ctxs: FanOutContext[] = [];
  const out = await runFanOut(flows(4), { runFlow: costly(0.4, ctxs), budgetUsd: 1 });
  check('each run gets the remaining budget as its cap', ctxs[0].spendCapUsd === 1 && Math.abs((ctxs[1].spendCapUsd ?? 0) - 0.6) < 1e-9 && Math.abs((ctxs[2].spendCapUsd ?? 0) - 0.2) < 1e-9);
  check('4th flow skipped after overshoot', ctxs.length === 3 && out.flows[3].reason.startsWith('stopped: spending limit reached'));
  check('cap becomes run option', runOptionsFromContext(ctxs[1]).config?.spendCapUsd === 0.6);
}
// --- no cap: nothing skipped, no cap handed down
{
  const ctxs: FanOutContext[] = [];
  const out = await runFanOut(flows(3), { runFlow: costly(5, ctxs) });
  check('uncapped batch runs everything', out.verdict === 'pass' && ctxs.every((c) => c.spendCapUsd === undefined));
}
// --- an earlier fail still wins over the skipped flows
{
  const out = await runFanOut(flows(3), { runFlow: async () => ({ verdict: 'fail' as const, spendSummary: { estimatedUsd: 1 } }), budgetUsd: 1 });
  check('fail beats uncertain', out.verdict === 'fail');
}
// --- budget helpers
{
  const b = new SpendBudget(1);
  b.add({ estimatedUsd: 0.5, paidCalls: 1 });
  check('remaining/exhausted', b.remaining() === 0.5 && !b.exhausted());
  check('parse --budget', parseBudgetFlag('2.5') === 2.5 && parseBudgetFlag(undefined) === undefined && (() => { try { parseBudgetFlag('-1'); return false; } catch { return true; } })());
  check('explicit budget beats the unattended default', resolveUnattendedBudget(3, { unattendedBudgetUsd: 1 }) === 3 && resolveUnattendedBudget(undefined, { unattendedBudgetUsd: 1 }) === 1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-spend-'));
  fs.mkdirSync(path.join(dir, 'a'));
  fs.writeFileSync(path.join(dir, 'a', 'report.json'), JSON.stringify({ spendSummary: { estimatedUsd: 0.3, paidCalls: 3 } }));
  check('spendSince sums reports', spendSince(dir, 0).estimatedUsd === 0.3 && spendSince(dir, Date.now() + 60_000).estimatedUsd === 0);
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- A11: log in once per batch
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-login-'));
  const session = path.join(dir, 'session.json');
  const ctxs: FanOutContext[] = [];
  const runFlow = async (_f: unknown, _i: number, ctx: FanOutContext) => {
    ctxs.push({ ...ctx });
    if (ctx.saveStorageStatePath) fs.writeFileSync(ctx.saveStorageStatePath, '{"cookies":[]}');
    return { verdict: 'pass' as const };
  };
  const list = [{ name: 'a', task: 'Open the pricing page' }, { name: 'b', task: 'Log in and open settings' }, { name: 'c', task: 'Check the cart' }, { name: 'd', task: 'Sign in again' }];
  await runFanOut(list, { runFlow, loginOnce: { path: session } });
  check('flow before any login gets no session', !ctxs[0].storageStatePath && !ctxs[0].saveStorageStatePath);
  check('login flow is asked to save the session', ctxs[1].saveStorageStatePath === session);
  check('flow 3 and 4 receive the session path', ctxs[2].storageStatePath === session && ctxs[3].storageStatePath === session);
  check('no second save request', !ctxs[2].saveStorageStatePath && !ctxs[3].saveStorageStatePath);
  check('session file removed at batch end', !fs.existsSync(session));

  // kept when the user asked; not used when a storage state was supplied
  await runFanOut(list, { runFlow, loginOnce: { path: session, keep: true } });
  check('kept with --save-storage-state', fs.existsSync(session));
  if (process.platform !== 'win32') check('session file is 0600', (fs.statSync(session).mode & 0o777) === 0o600);
  ctxs.length = 0;
  fs.rmSync(session, { force: true });
  await runFanOut(list, { runFlow, storageStatePath: '/given.json', loginOnce: { path: session } });
  check('supplied storage state wins, no save asked', ctxs.every((c) => c.storageStatePath === '/given.json' && !c.saveStorageStatePath));
  // a failing login is not adopted
  ctxs.length = 0;
  await runFanOut(list, { runFlow: async (_f, _i, ctx) => { ctxs.push({ ...ctx }); return { verdict: 'fail' as const }; }, loginOnce: { path: session } });
  check('failed login is retried by the next login flow, not shared', !ctxs[2].storageStatePath && ctxs[3].saveStorageStatePath === session);
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- A8: unattended defaults, in the job store and scheduler
{
  const { JobStore } = await import('../src/schedule/store.js');
  const { runJob } = await import('../src/schedule/scheduler.js');
  const { jobArgs } = await import('../src/schedule/job-runner.js');
  const { loadConfig } = await import('../src/config.js');
  check('config defaults: $1 unattended, $2 CI', loadConfig().unattendedBudgetUsd === 1 && loadConfig().ciBudgetUsd === 2);
  process.env.SPIKE_UNATTENDED_BUDGET_USD = '3.5';
  process.env.SPIKE_CI_BUDGET_USD = 'garbage';
  const c = loadConfig();
  check('env overrides unattended cap; garbage ignored', c.unattendedBudgetUsd === 3.5 && c.ciBudgetUsd === 2);
  delete process.env.SPIKE_UNATTENDED_BUDGET_USD; delete process.env.SPIKE_CI_BUDGET_USD;

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-cap-'));
  try {
    const store = new JobStore({ home });
    let clock = Date.UTC(2026, 8, 24, 12, 0);
    const job = store.add({ target: 'suite', url: 'http://x.test', when: 'hourly' }, clock); // no budget of its own
    const budgets: Array<number | undefined> = [];
    const deps = { store, now: () => clock, defaultBudgetUsd: 1, notify: async () => {}, run: async (_j: unknown, ctx?: { budgetUsd?: number }) => { budgets.push(ctx?.budgetUsd); return { verdict: 'pass' as const, costUsd: 0.6 }; } };
    await runJob(store.get(job.id)!, deps);
    check('first run gets the whole default cap', budgets[0] === 1);
    clock += 3_600_000;
    await runJob(store.get(job.id)!, deps);
    check('second run gets what is left', Math.abs((budgets[1] ?? 0) - 0.4) < 1e-9 && Math.abs(store.get(job.id)!.spentTodayUsd - 1.2) < 1e-9);
    clock += 3_600_000;
    const r = await runJob(store.get(job.id)!, deps);
    check('job at its daily cap is skipped with a plain reason', budgets.length === 2 && r.verdict === 'uncertain' && /spending limit reached/.test(r.summary ?? ''));
    clock += 24 * 3_600_000;
    await runJob(store.get(job.id)!, deps);
    check('cap resets after 24 hours', budgets.length === 3 && budgets[2] === 1);
    const own = store.add({ target: 'check', url: 'http://y.test', when: 'hourly', budgetUsd: 5 }, clock);
    await runJob(store.get(own.id)!, deps);
    check('explicit job budget beats the default', budgets[3] === 5);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  check('job argv carries the remaining budget', jobArgs({ kind: 'suite', target: '', url: '' } as never, 0.4).join(' ').endsWith('--budget 0.40') && !jobArgs({ kind: 'suite', target: '', url: '' } as never).includes('--budget'));
}

// --- A10: the check's fan-out controls reach the fan-out
{
  const { runSiteCheck } = await import('../src/discovery/run-check.js');
  const { emptyAppModel, upsertStaticRoute } = await import('../src/discovery/index.js');
  const model = emptyAppModel('https://shop.example/');
  for (const r of ['/a', '/b', '/c', '/d']) upsertStaticRoute(model, r);
  const seen: FanOutContext[] = [];
  const r = await runSiteCheck('https://shop.example/', { budgetUsd: 1, stopOnFail: true, stepsPerPage: 7 }, {
    buildMap: async () => model,
    saveModel: () => {},
    runPage: async (_t, _a, _o, ctx) => { seen.push(ctx!); return { verdict: 'fail' as const, spendSummary: { estimatedUsd: 0.3, paidCalls: 1 } }; },
  });
  check('--steps-per-flow reaches each page run', seen.length > 0 && seen.every((c) => c.maxSteps === 7));
  check('--stop-on-fail stops after the first failing page', seen.length === 1 && r.outcome.verdict === 'fail');
  check('--budget reaches the check as the batch cap', seen[0].spendCapUsd === 1 && r.outcome.spend?.budgetUsd === 1);
}

process.exit(failed ? 1 : 0);
