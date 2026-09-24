/* A8 (P0) — the fan-out orchestrator: many budgeted runs, ONE verdict.
 *
 * A single run has a hard step budget, so "test my whole app" was structurally
 * impossible: one realistic flow costs 5-10 steps, and there was nothing above
 * a single run to spend a second budget. This module is that missing layer.
 *
 * It takes a list of units to test — flows (A7's document intake, or a caller's
 * own pre-split list) or routes (a future input from app-model discovery) —
 * normalizes them into one shape, runs each as its OWN budgeted run with the
 * SAME shared sign-in state, and rolls the per-unit verdicts into one
 * (fail beats uncertain beats pass). It also keeps the coverage ledger the
 * audit asked for: how many flows it got through, how many pages it reached,
 * how many controls it actually operated — so a non-pass verdict says how much
 * of the app was checked instead of reading as "nothing works".
 *
 * Deliberately dependency-light, exactly like the loop it replaces: the
 * per-unit runner is an INJECTED function rather than an import of the engine.
 * That keeps the fast test suite free of Chrome/model/network and keeps this
 * module free of an import edge into src/engine.ts. `src/driver/spec-decompose.ts`
 * keeps only the document→flows half and re-exports everything here, so there is
 * exactly one fan-out loop and one aggregation rule in the codebase.
 */

import fs from 'node:fs';
import type { RunCoverage, RunVerdict, StepRecord } from '../report/report.js';
import { SpendBudget, formatUsd, type SpendLike, type SpendTotals } from './budget.js';

/** A11: a flow whose task mentions logging in is the one whose passing run
 * leaves a usable session behind. */
export const LOGIN_PATTERN = /\b(log ?in|sign ?in)\b/i;

/** Hard cap on units in one fan-out. More than this is a suite, not a run —
 * the extra units are dropped rather than silently multiplying the cost of a
 * single command. */
export const MAX_FLOWS = 20;
/** Each unit's task must stay a single instruction the driver can hold in
 * every prompt. Longer strings are truncated, not rejected. */
export const MAX_FLOW_TASK_CHARS = 300;
/** Labels are for humans reading the result table. */
export const MAX_FLOW_NAME_CHARS = 80;

/** One testable unit of work: a flow from a document, a caller-supplied
 * instruction, or a route turned into an instruction. */
export interface FlowUnit {
  /** Short human label for the result table, e.g. "Checkout with a saved card". */
  name: string;
  /** The self-contained plain-English instruction handed to a single run. */
  task: string;
}

/** Back-compat alias — A7's name for the same shape. */
export type SpecFlow = FlowUnit;

/** A route as app-model discovery records one. Accepted as an input shape now
 * so the orchestrator is ready for the discovery → fan-out wiring; nothing
 * populates it from discovery yet. */
export interface RouteUnit {
  /** Absolute URL, when discovery recorded one. */
  url?: string;
  /** Path relative to the app's origin ("/checkout"), when it did not. */
  path?: string;
  /** Human label for the route ("Checkout"). */
  name?: string;
  /** Page title, used as a label when `name` is absent. */
  title?: string;
  /** A ready-made instruction for this route, when the caller has one. */
  task?: string;
}

/** Trim a string to a cap without cutting mid-word where avoidable. */
export function clampText(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/** Clamp/label/cap a unit list. Shared by every entry point (the document
 * path, a caller's pre-split list, the route path) so all of them obey the
 * same limits. */
export function normalizeFlows(flows: Array<FlowUnit | string>, maxFlows = MAX_FLOWS): FlowUnit[] {
  const cap = Math.max(1, Math.min(maxFlows, MAX_FLOWS));
  return flows
    .map((f) => (typeof f === 'string' ? { name: f, task: f } : f))
    .map((f) => ({
      name: clampText(f.name || f.task, MAX_FLOW_NAME_CHARS),
      task: clampText(f.task, MAX_FLOW_TASK_CHARS),
    }))
    .filter((f) => f.task.length > 0)
    .slice(0, cap);
}

export interface RouteFlowOptions {
  /** Origin used to turn a bare path into a full address in the instruction. */
  baseUrl?: string;
  maxFlows?: number;
  /** Override the instruction written for each route. */
  instruction?: (route: RouteUnit, address: string) => string;
}

/** Absolute address for a route, best effort — a bad base or a bad path just
 * degrades to whatever string we were given. */
function routeAddress(route: RouteUnit, baseUrl?: string): string {
  if (route.url) return route.url;
  const p = route.path ?? '/';
  if (!baseUrl) return p;
  try {
    return new URL(p, baseUrl).toString();
  } catch {
    return p;
  }
}

/** Turn discovered routes into testable units. The default instruction is a
 * look-at-this-page check, because a route is a place, not an intention — a
 * caller that knows what a route is FOR supplies `task` or `instruction`. */
export function flowsFromRoutes(routes: RouteUnit[], opts: RouteFlowOptions = {}): FlowUnit[] {
  const units = routes.map((r) => {
    const address = routeAddress(r, opts.baseUrl);
    const label = r.name || r.title || r.path || r.url || address;
    const task =
      r.task ??
      opts.instruction?.(r, address) ??
      `Open ${address} and check the page loads and works: nothing is broken or missing, and the main things on it can be used.`;
    return { name: label, task };
  });
  return normalizeFlows(units, opts.maxFlows);
}

/* ---------- coverage accounting ------------------------------------------- */

/** Actions that count as operating a control. Looking at a page (a check, a
 * wait, a screenshot) is not exercising anything, and counting it would inflate
 * the one number a user is meant to trust. */
const CONTROL_ACTIONS = new Set(['click', 'type', 'select_option', 'press_key', 'upload_file', 'drag_and_drop']);

/** One page address, fragment removed — "/cart#top" and "/cart" are one page. */
function pageKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch {
    return url.split('#')[0];
  }
}

export interface StepCoverage {
  /** Distinct page addresses the run reached. */
  pages: string[];
  /** Distinct controls the run actually operated. */
  controlsExercised: number;
}

/** What one run's steps prove about how much of the app was covered.
 * Controls are counted DISTINCTLY (same button on the same page clicked three
 * times is one control), because the audit's livelock case would otherwise
 * report 31 controls for one repeated check. */
export function coverageFromSteps(steps: StepRecord[] | undefined, seedUrl?: string): StepCoverage {
  const pages = new Set<string>();
  const controls = new Set<string>();
  if (seedUrl) pages.add(pageKey(seedUrl));
  for (const s of steps ?? []) {
    if (s.url) pages.add(pageKey(s.url));
    if (s.action.type === 'navigate' && typeof s.action.url === 'string') pages.add(pageKey(s.action.url));
    if (!s.ok || !CONTROL_ACTIONS.has(s.action.type)) continue;
    const where = s.url ? pageKey(s.url) : '';
    const what = s.target
      ? `${s.target.role}:${s.target.name ?? ''}:${s.target.nth ?? 0}`
      : 'nodeId' in s.action && typeof s.action.nodeId === 'string'
        ? s.action.nodeId
        : String(s.index);
    controls.add(`${where}|${s.action.type}|${what}`);
  }
  return { pages: [...pages], controlsExercised: controls.size };
}

/** Coverage for a SINGLE run — one flow, its pages, its controls. */
export function singleRunCoverage(steps: StepRecord[] | undefined, seedUrl?: string): RunCoverage {
  const c = coverageFromSteps(steps, seedUrl);
  return { flowsAttempted: 1, flowsTotal: 1, pagesVisited: c.pages.length, controlsExercised: c.controlsExercised };
}

/* ---------- running the units + one verdict -------------------------------- */

/** The per-unit result the caller renders/returns. `evidence_paths` is the
 * slim contract's own field, carried through unchanged. */
export interface FlowOutcome {
  name: string;
  task: string;
  verdict: RunVerdict;
  reason: string;
  evidence_paths: string[];
  /** How much this one flow got through. Absent when the run handed back
   * nothing to count (a thrown flow, a caller returning a bare verdict). */
  coverage?: RunCoverage;
}

export interface FanOutOutcome {
  /** fail if any flow failed; uncertain if any was uncertain and none failed; else pass. */
  verdict: RunVerdict;
  flows: FlowOutcome[];
  /** The whole fan-out's coverage: flows got through, pages reached across all
   * of them, controls operated. */
  coverage: RunCoverage;
  /** A8: what the batch spent, when any run reported spend or a cap was set. */
  spend?: SpendTotals;
}

/** Back-compat alias — A7's name for the same shape. */
export type SpecRunOutcome = FanOutOutcome;

/** Roll per-flow verdicts into one. Empty list is `uncertain` — nothing was
 * actually checked, which must never read as a pass. */
export function aggregateVerdict(verdicts: RunVerdict[]): RunVerdict {
  if (!verdicts.length) return 'uncertain';
  if (verdicts.includes('fail')) return 'fail';
  if (verdicts.includes('uncertain')) return 'uncertain';
  return 'pass';
}

/** The minimum a run has to hand back — satisfied by a full Report, which also
 * carries `steps`/`url` and so gets real coverage accounting for free. */
export interface FlowRunResult {
  verdict: RunVerdict;
  reason?: string;
  evidence_paths?: string[];
  /** Full-report extras, used for coverage when present. */
  steps?: StepRecord[];
  url?: string;
  coverage?: RunCoverage;
  /** A8: the run's spend (a full Report carries this). */
  spendSummary?: SpendLike;
}

/** What each run is told about its place in the fan-out. `storageStatePath` is
 * the shared sign-in state: every flow starts already logged in, so flow 2 does
 * not spend its budget repeating flow 1's login. */
export interface FanOutContext {
  index: number;
  total: number;
  storageStatePath?: string;
  maxSteps?: number;
  /** A8: what is left of the batch budget — hand it to the run as its own cap
   * so one runaway flow also stops. Undefined = no cap. */
  spendCapUsd?: number;
  /** A11: when set, ask the run to save its session here if it passes (the
   * first login of the batch); later flows get it as `storageStatePath`. */
  saveStorageStatePath?: string;
}

/** The run options a `runFlow` callback should merge in from its context —
 * kept here so every caller wires storage state and the per-run cap the same way. */
export function runOptionsFromContext(ctx: FanOutContext): {
  storageStatePath?: string;
  saveStorageStatePath?: string;
  config?: { spendCapUsd: number };
} {
  return {
    ...(ctx.storageStatePath && { storageStatePath: ctx.storageStatePath }),
    ...(ctx.saveStorageStatePath && { saveStorageStatePath: ctx.saveStorageStatePath }),
    ...(ctx.spendCapUsd !== undefined && { config: { spendCapUsd: Math.max(ctx.spendCapUsd, 0.01) } }),
  };
}

export interface FanOutOptions {
  /** Runs ONE unit (the caller supplies the real run call, with its transport
   * already bound, and should honour the context's shared state/budget). */
  runFlow: (flow: FlowUnit, index: number, ctx: FanOutContext) => Promise<FlowRunResult>;
  /** Progress lines for the CLI; ignored when absent. */
  onProgress?: (line: string) => void;
  /** Sign-in state shared by every run in this fan-out. */
  storageStatePath?: string;
  /** Step budget handed to each individual run. */
  maxStepsPerFlow?: number;
  /** Stop as soon as a flow fails (default false — a full sweep is the point). */
  stopOnFirstFailure?: boolean;
  /** Cooperative cancellation: an aborted fan-out stops between flows and
   * reports the coverage it reached. */
  signal?: AbortSignal;
  /** A8: stop the batch once this much has been spent; remaining flows are
   * skipped (uncertain, with the reason). */
  budgetUsd?: number;
  /** A11: log in once per batch. Used only when no `storageStatePath` was
   * supplied. `path` is where the first passing login's session is saved
   * (0600); it is deleted at the end unless `keep` (the user asked to keep it). */
  loginOnce?: { path: string; keep?: boolean; pattern?: RegExp };
}

/** Run every unit in order, one budgeted run each, and aggregate. A unit that
 * throws is recorded as `uncertain` with the error text rather than aborting
 * the rest — one broken flow must not hide the verdict of the others. */
export async function runFanOut(flows: FlowUnit[], opts: FanOutOptions): Promise<FanOutOutcome> {
  const outcomes: FlowOutcome[] = [];
  // Pages are UNIONed across flows (two flows both touching /cart is one page),
  // which needs the addresses — available whenever the run handed back steps.
  const pages = new Set<string>();
  // A caller that returns only a pre-computed coverage block gives us counts
  // and no addresses, so those pages can only be added, not de-duplicated.
  let uncountedPages = 0;
  let controls = 0;
  let attempted = 0;

  const budget = new SpendBudget(opts.budgetUsd);
  let sawSpend = false;
  const login = opts.storageStatePath ? undefined : opts.loginOnce;
  let sessionCaptured = false;

  try {
  for (const [i, flow] of flows.entries()) {
    if (opts.signal?.aborted) break;
    if (budget.exhausted()) {
      const reason = budget.stopReason();
      opts.onProgress?.(reason);
      for (const rest of flows.slice(i)) {
        outcomes.push({ name: rest.name, task: rest.task, verdict: 'uncertain', reason, evidence_paths: [] });
      }
      break;
    }
    opts.onProgress?.(`Flow ${i + 1} of ${flows.length}: ${flow.name}`);
    attempted++;
    try {
      const wantSave = Boolean(login && !sessionCaptured && (login.pattern ?? LOGIN_PATTERN).test(flow.task));
      const r = await opts.runFlow(flow, i, {
        index: i,
        total: flows.length,
        storageStatePath: sessionCaptured && login ? login.path : opts.storageStatePath,
        maxSteps: opts.maxStepsPerFlow,
        ...(budget.remaining() !== undefined && { spendCapUsd: budget.remaining() }),
        ...(wantSave && login && { saveStorageStatePath: login.path }),
      });
      if (r.spendSummary) sawSpend = true;
      budget.add(r.spendSummary);
      if (wantSave && login && r.verdict === 'pass' && fs.existsSync(login.path)) {
        sessionCaptured = true;
        try { fs.chmodSync(login.path, 0o600); } catch { /* best effort (Windows) */ }
        opts.onProgress?.('Signed in once — the remaining flows reuse this session.');
      }
      const hasSteps = Boolean(r.steps?.length);
      const counted = coverageFromSteps(r.steps, r.url);
      let flowCoverage: RunCoverage;
      if (hasSteps) {
        for (const p of counted.pages) pages.add(p);
        controls += counted.controlsExercised;
        flowCoverage = {
          flowsAttempted: 1,
          flowsTotal: 1,
          pagesVisited: counted.pages.length,
          controlsExercised: counted.controlsExercised,
        };
      } else {
        flowCoverage = r.coverage ?? { flowsAttempted: 1, flowsTotal: 1, pagesVisited: 0, controlsExercised: 0 };
        uncountedPages += flowCoverage.pagesVisited;
        controls += flowCoverage.controlsExercised;
      }
      outcomes.push({
        name: flow.name,
        task: flow.task,
        verdict: r.verdict,
        reason: r.reason ?? '',
        evidence_paths: r.evidence_paths ?? [],
        coverage: flowCoverage,
      });
    } catch (e) {
      outcomes.push({
        name: flow.name,
        task: flow.task,
        verdict: 'uncertain',
        reason: `I could not finish this flow: ${e instanceof Error ? e.message : String(e)}`,
        evidence_paths: [],
      });
    }
    opts.onProgress?.(`  → ${outcomes[outcomes.length - 1].verdict}`);
    if (opts.stopOnFirstFailure && outcomes[outcomes.length - 1].verdict === 'fail') break;
  }
  } finally {
    if (login && !login.keep) {
      try { fs.rmSync(login.path, { force: true }); } catch { /* best effort */ }
    }
  }

  return {
    verdict: aggregateVerdict(outcomes.map((o) => o.verdict)),
    flows: outcomes,
    coverage: {
      flowsAttempted: attempted,
      flowsTotal: flows.length,
      pagesVisited: pages.size + uncountedPages,
      controlsExercised: controls,
    },
    ...((sawSpend || opts.budgetUsd !== undefined) && { spend: budget.totals() }),
  };
}

/** Back-compat names for the fan-out loop (A7 called it runFlows). */
export const runFlows = runFanOut;
export type RunFlowsOptions = FanOutOptions;

/* ---------- what a person reads ------------------------------------------- */

const VERDICT_LABEL: Record<RunVerdict, string> = {
  pass: 'passed',
  fail: 'FAILED',
  uncertain: 'not sure',
};

/** One plain sentence saying how much of the app was actually checked. Shown
 * on every non-pass result, because "couldn't finish" with no coverage reads
 * as "none of your app works". */
export function renderCoverageLine(c: RunCoverage): string {
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  return `I got through ${c.flowsAttempted} of ${plural(c.flowsTotal, 'flow')}, visited ${plural(c.pagesVisited, 'page')} and tried ${plural(c.controlsExercised, 'control')}.`;
}

/** One plain sentence on what the batch cost. Empty when nothing was measured. */
export function renderSpendLine(spend: SpendTotals | undefined): string {
  if (!spend) return '';
  const paid = `${spend.paidCalls} paid model call${spend.paidCalls === 1 ? '' : 's'}`;
  const limit = spend.budgetUsd !== undefined ? ` of your ${formatUsd(spend.budgetUsd)} limit` : '';
  return `\nSpent about ${formatUsd(spend.estimatedUsd)}${limit} (${paid}).`;
}

/** The per-flow verdict table, the one-line overall verdict, and (when it did
 * not all pass) the coverage line. Plain words only — this is what a
 * non-engineer reads in the terminal. */
export function renderFlowTable(outcome: FanOutOutcome): string {
  const width = Math.max(0, ...outcome.flows.map((f) => f.name.length));
  const rows = outcome.flows.map((f, i) => {
    const head = `${String(i + 1).padStart(2)}. ${f.name.padEnd(width)}  ${VERDICT_LABEL[f.verdict]}`;
    return f.verdict === 'pass' || !f.reason ? head : `${head}\n      ${clampText(f.reason, 200)}`;
  });
  const failed = outcome.flows.filter((f) => f.verdict === 'fail').length;
  const unsure = outcome.flows.filter((f) => f.verdict === 'uncertain').length;
  const total = outcome.flows.length;
  const summary =
    outcome.verdict === 'pass'
      ? `All ${total} flow${total === 1 ? '' : 's'} passed.`
      : outcome.verdict === 'fail'
        ? `${failed} of ${total} flow${total === 1 ? '' : 's'} failed.`
        : `${unsure} of ${total} flow${total === 1 ? '' : 's'} could not be checked.`;
  const coverage = outcome.verdict === 'pass' ? '' : `\n${renderCoverageLine(outcome.coverage)}`;
  return `${rows.join('\n')}\n\nOverall: ${outcome.verdict} — ${summary}${coverage}${renderSpendLine(outcome.spend)}`;
}
