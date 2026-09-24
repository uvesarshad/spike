/* `spike bench navigator <provider:model>` (E1): is a new cheap model good
 * enough to click through pages? Runs a fixed set of flows once per repeat
 * with the candidate driving the page and again with the current default,
 * then prints success rate, steps, planner escalations and cost side by side
 * plus a GO / NO-GO. Generalises spikes/nano-nav/ (a one-off GO/NO-GO for Nano).
 *
 * The runner is INJECTED (`runFlow`) so this module imports neither the engine
 * nor a browser: tests drive it with a stub, and only the CLI wires the real
 * qaRun. It costs real money and needs Chrome, so the CLI asks for --yes. */

import type { Report } from '../report/report.js';

export interface BenchFlow {
  name: string;
  task: string;
  /** Absolute address, or the literal `{fixture}` for the local demo shop. */
  url: string;
}

/** Fixed on purpose: the same flows every time is what makes two models comparable. */
export const BENCH_FLOWS: BenchFlow[] = [
  { name: 'fixture-login', task: 'Log in with the demo account and confirm the products page shows.', url: '{fixture}/login' },
  { name: 'fixture-checkout', task: 'Log in, add the first product to the cart, and place the order.', url: '{fixture}/login' },
  { name: 'example-link', task: 'Follow the "More information" link and confirm a page about reserved example domains loads.', url: 'https://example.com' },
  { name: 'herokuapp-login', task: 'Log in with username tomsmith and password SuperSecretPassword! and confirm the secure area shows.', url: 'https://the-internet.herokuapp.com/login' },
];

export interface ModelPin { provider: string; mode: 'api' | 'cli' | 'ondevice'; model?: string; label: string }

/** `gemini:gemini-3-flash` -> pin. `nano` -> on-device. A `cli:` prefix on the provider (`cli:claude:haiku`) selects the local CLI. */
export function parseModelPin(spec: string): ModelPin | null {
  const parts = spec.split(':').map((s) => s.trim());
  let mode: ModelPin['mode'] = 'api';
  if (parts[0] === 'cli') { mode = 'cli'; parts.shift(); }
  const provider = parts[0]?.toLowerCase();
  if (!provider || !['nano', 'gemini', 'claude', 'gpt', 'ollama', 'openrouter', 'glm'].includes(provider)) return null;
  if (provider === 'nano') mode = 'ondevice';
  const model = parts.slice(1).join(':') || undefined;
  return { provider, mode, ...(model && { model }), label: spec };
}

export interface FlowOutcome { verdict: Report['verdict']; steps: number; escalations: number; usd: number; tokens: number }

/** Boils a full report down to what the bench compares. Brain calls beyond the first plan are escalations. */
export function outcomeFromReport(r: Pick<Report, 'verdict' | 'steps' | 'model_trace' | 'spendSummary'>): FlowOutcome {
  const brainCalls = (r.model_trace ?? []).filter((t) => t.capability === 'plan-goals').length;
  return {
    verdict: r.verdict,
    steps: r.steps?.length ?? 0,
    escalations: Math.max(0, brainCalls - 1),
    usd: r.spendSummary?.estimatedUsd ?? 0,
    tokens: r.spendSummary?.totalTokens ?? 0,
  };
}

export interface ArmSummary {
  label: string;
  runs: number;
  passRate: number;
  avgSteps: number;
  avgEscalations: number;
  totalUsd: number;
  totalTokens: number;
  byFlow: Record<string, { passes: number; runs: number }>;
}

export function summarizeArm(label: string, results: { flow: string; outcome: FlowOutcome }[]): ArmSummary {
  const n = results.length || 1;
  const byFlow: ArmSummary['byFlow'] = {};
  for (const r of results) {
    const b = (byFlow[r.flow] ??= { passes: 0, runs: 0 });
    b.runs++;
    if (r.outcome.verdict === 'pass') b.passes++;
  }
  const sum = (f: (o: FlowOutcome) => number) => results.reduce((a, r) => a + f(r.outcome), 0);
  return {
    label,
    runs: results.length,
    passRate: results.length ? sum((o) => (o.verdict === 'pass' ? 1 : 0)) / n : 0,
    avgSteps: sum((o) => o.steps) / n,
    avgEscalations: sum((o) => o.escalations) / n,
    totalUsd: sum((o) => o.usd),
    totalTokens: sum((o) => o.tokens),
    byFlow,
  };
}

export interface BenchDecision { decision: 'GO' | 'NO-GO'; reasons: string[] }

/** GO needs: no worse than 10 points below the baseline's pass rate, no more than 0.5 extra planner escalations per run on average, and not more expensive. */
export function decide(candidate: ArmSummary, baseline: ArmSummary): BenchDecision {
  const reasons: string[] = [];
  if (candidate.runs === 0) return { decision: 'NO-GO', reasons: ['no runs completed'] };
  if (candidate.passRate < baseline.passRate - 0.1) reasons.push(`passes ${pct(candidate.passRate)} of flows vs ${pct(baseline.passRate)} for the current default`);
  if (candidate.avgEscalations > baseline.avgEscalations + 0.5) reasons.push(`needs the planner to step in ${candidate.avgEscalations.toFixed(1)}x per run vs ${baseline.avgEscalations.toFixed(1)}x`);
  if (candidate.totalUsd > baseline.totalUsd && baseline.totalUsd > 0) reasons.push(`costs more (about $${candidate.totalUsd.toFixed(3)} vs $${baseline.totalUsd.toFixed(3)})`);
  return { decision: reasons.length ? 'NO-GO' : 'GO', reasons };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export interface BenchResult { candidate: ArmSummary; baseline: ArmSummary; decision: BenchDecision; flows: string[] }

export interface BenchOptions {
  candidate: ModelPin;
  baseline: ModelPin;
  flows?: BenchFlow[];
  repeats?: number;
  /** Runs one flow with the given model driving the page. Must not throw for a failed run; a throw counts as an errored run. */
  runFlow: (flow: BenchFlow, pin: ModelPin) => Promise<FlowOutcome>;
  progress?: (line: string) => void;
}

export async function runNavigatorBench(o: BenchOptions): Promise<BenchResult> {
  const flows = o.flows ?? BENCH_FLOWS;
  const repeats = Math.max(1, o.repeats ?? 1);
  const arms: Record<'candidate' | 'baseline', { flow: string; outcome: FlowOutcome }[]> = { candidate: [], baseline: [] };
  for (const arm of ['candidate', 'baseline'] as const) {
    const pin = o[arm];
    for (let i = 0; i < repeats; i++) {
      for (const flow of flows) {
        o.progress?.(`${arm} ${pin.label}: ${flow.name} (${i + 1}/${repeats})`);
        let outcome: FlowOutcome;
        try { outcome = await o.runFlow(flow, pin); }
        catch { outcome = { verdict: 'error' as FlowOutcome['verdict'], steps: 0, escalations: 0, usd: 0, tokens: 0 }; }
        arms[arm].push({ flow: flow.name, outcome });
      }
    }
  }
  const candidate = summarizeArm(o.candidate.label, arms.candidate);
  const baseline = summarizeArm(o.baseline.label, arms.baseline);
  return { candidate, baseline, decision: decide(candidate, baseline), flows: flows.map((f) => f.name) };
}

export function renderBenchReport(r: BenchResult): string {
  const row = (name: string, c: string, b: string) => `  ${name.padEnd(28)}${c.padEnd(16)}${b}`;
  const lines = [
    `Model comparison for clicking through pages (${r.flows.length} flows)`,
    '',
    row('', r.candidate.label, r.baseline.label),
    row('flows passed', pct(r.candidate.passRate), pct(r.baseline.passRate)),
    row('average steps', r.candidate.avgSteps.toFixed(1), r.baseline.avgSteps.toFixed(1)),
    row('planner stepped in (avg)', r.candidate.avgEscalations.toFixed(1), r.baseline.avgEscalations.toFixed(1)),
    row('about cost (USD)', `$${r.candidate.totalUsd.toFixed(3)}`, `$${r.baseline.totalUsd.toFixed(3)}`),
    '',
  ];
  for (const f of r.flows) {
    const c = r.candidate.byFlow[f], b = r.baseline.byFlow[f];
    lines.push(row(f, c ? `${c.passes}/${c.runs}` : '-', b ? `${b.passes}/${b.runs}` : '-'));
  }
  lines.push('', `Result: ${r.decision.decision}${r.decision.reasons.length ? ` - ${r.decision.reasons.join('; ')}` : ' - as good as the current default at no higher cost'}`);
  return lines.join('\n');
}
