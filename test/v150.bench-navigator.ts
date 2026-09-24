/* V150 — `spike bench navigator` harness + report logic (E1), stub runner only. */
import { BENCH_FLOWS, decide, outcomeFromReport, parseModelPin, renderBenchReport, runNavigatorBench, type FlowOutcome } from '../src/bench/navigator.js';

const check = (l: string, ok: boolean) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`); if (!ok) process.exitCode = 1; };

check('parse: provider:model', JSON.stringify(parseModelPin('gemini:flash-x')) === JSON.stringify({ provider: 'gemini', mode: 'api', model: 'flash-x', label: 'gemini:flash-x' }));
check('parse: nano is on-device', parseModelPin('nano')?.mode === 'ondevice');
check('parse: cli prefix', parseModelPin('cli:claude:haiku')?.mode === 'cli');
check('parse: unknown provider rejected', parseModelPin('bogus:x') === null);

const rep: any = {
  verdict: 'pass', steps: [{}, {}, {}],
  model_trace: [{ capability: 'plan-goals' }, { capability: 'plan-step' }, { capability: 'plan-goals' }, { capability: 'plan-goals' }],
  spendSummary: { estimatedUsd: 0.02, totalTokens: 900 },
};
const oc = outcomeFromReport(rep);
check('outcome: escalations = brain calls beyond the first plan', oc.escalations === 2 && oc.steps === 3 && oc.usd === 0.02);

const ok = (o: Partial<FlowOutcome> = {}): FlowOutcome => ({ verdict: 'pass', steps: 5, escalations: 0, usd: 0.01, tokens: 100, ...o });
const cand = parseModelPin('gemini:new')!, base = parseModelPin('claude:haiku')!;

const calls: string[] = [];
const good = await runNavigatorBench({
  candidate: cand, baseline: base, repeats: 2,
  runFlow: async (f, pin) => { calls.push(`${pin.label}/${f.name}`); return pin === cand ? ok({ usd: 0.005 }) : ok(); },
});
check('runs every flow for both arms, repeated', calls.length === BENCH_FLOWS.length * 2 * 2);
check('cheaper + equal pass rate -> GO', good.decision.decision === 'GO');
check('report names both models and the result', /gemini:new/.test(renderBenchReport(good)) && /claude:haiku/.test(renderBenchReport(good)) && /Result: GO/.test(renderBenchReport(good)));

const worse = await runNavigatorBench({
  candidate: cand, baseline: base, flows: BENCH_FLOWS.slice(0, 2),
  runFlow: async (_f, pin) => (pin === cand ? ok({ verdict: 'fail' }) : ok()),
});
check('lower pass rate -> NO-GO with a reason', worse.decision.decision === 'NO-GO' && /passes 0%/.test(worse.decision.reasons[0]));

const thrower = await runNavigatorBench({
  candidate: cand, baseline: base, flows: BENCH_FLOWS.slice(0, 1),
  runFlow: async (_f, pin) => { if (pin === cand) throw new Error('boom'); return ok(); },
});
check('a throwing runner counts as a failed run, not a crash', thrower.candidate.passRate === 0 && thrower.decision.decision === 'NO-GO');

const esc = decide(
  { ...good.candidate, avgEscalations: 2 }, { ...good.baseline, avgEscalations: 0 });
check('too many planner escalations -> NO-GO', esc.decision === 'NO-GO');
check('bench flows are fixed and include the local shop', BENCH_FLOWS.some((f) => f.url.startsWith('{fixture}')) && BENCH_FLOWS.length >= 3);
