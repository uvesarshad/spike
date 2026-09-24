/* A7 — the daemon's scheduler. tick() runs every due job, one at a time.
 * The runner, clock and notifier are injected so tests use fakes. */

import { JobStore, spentInWindow, SPEND_WINDOW_MS, type Job } from './store.js';
import { formatUsd } from '../orchestrator/budget.js';
import { isDue } from './when.js';
import { notifyIfFlipped, type StatusChange, type Verdict } from './notify.js';

export interface JobResult {
  verdict: Verdict;
  runId?: string;
  costUsd?: number;
  summary?: string;
}

/** `budgetUsd` is what the job may still spend in this run (its cap minus what
 * it already spent in the last 24 h); undefined = uncapped. */
export type JobRunner = (job: Job, ctx?: { budgetUsd?: number }) => Promise<JobResult>;
export type StatusNotifier = (prev: Verdict | null, change: StatusChange, webhook?: string) => Promise<unknown>;

export interface SchedulerDeps {
  store: JobStore;
  run: JobRunner;
  now?: () => number;
  notify?: StatusNotifier;
  /** A8: the cap for a job that has no `budgetUsd` of its own (config
   * `unattendedBudgetUsd`). Undefined = such jobs are uncapped. */
  defaultBudgetUsd?: number;
}

/** Run one job now (used by tick and `schedule run-now`); records the result. */
export async function runJob(job: Job, deps: SchedulerDeps): Promise<JobResult> {
  const now = (deps.now ?? Date.now)();
  const spentBefore = spentInWindow(job, now);
  const cap = job.budgetUsd ?? deps.defaultBudgetUsd;
  let result: JobResult;
  if (cap !== undefined && spentBefore >= cap) {
    result = { verdict: 'uncertain', summary: `stopped: spending limit reached (${formatUsd(spentBefore)} of ${formatUsd(cap)} in the last 24 hours) — it will run again once that window passes` };
  } else {
    try {
      result = await deps.run(job, { ...(cap !== undefined && { budgetUsd: cap - spentBefore }) });
    } catch (e) {
      result = { verdict: 'uncertain', summary: `could not run: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  const finished = (deps.now ?? Date.now)();
  const windowStart = job.spendWindowStart !== undefined && now - job.spendWindowStart < SPEND_WINDOW_MS ? job.spendWindowStart : now;
  deps.store.update(job.id, {
    lastRunAt: finished,
    lastVerdict: result.verdict,
    lastRunId: result.runId,
    lastSummary: result.summary,
    spendWindowStart: windowStart,
    spentTodayUsd: spentBefore + (result.costUsd ?? 0),
  });
  const notify: StatusNotifier = deps.notify ?? ((p, c, w) => notifyIfFlipped(p, c, w));
  await notify(job.lastVerdict, {
    job: `${job.kind}${job.target ? `:${job.target}` : ''} (${job.id})`,
    verdict: result.verdict,
    url: job.url,
    ...(result.runId && { runId: result.runId }),
    summary: result.summary ?? result.verdict,
  }, job.webhook);
  return result;
}

let ticking = false;

/** Run every due job serially. A tick that overlaps a still-running one is a no-op. Returns the ids run. */
export async function tick(deps: SchedulerDeps): Promise<string[]> {
  if (ticking) return [];
  ticking = true;
  const ran: string[] = [];
  try {
    const now = (deps.now ?? Date.now)();
    for (const job of deps.store.list()) {
      let due = false;
      try { due = isDue(job, now); } catch { due = false; }
      if (!due) continue;
      await runJob(job, deps);
      ran.push(job.id);
    }
  } finally {
    ticking = false;
  }
  return ran;
}

/** Start the 60 s loop inside `spike daemon`. Returns a stop function. */
export function startScheduler(deps: SchedulerDeps, intervalMs = 60_000): () => void {
  const h = setInterval(() => { void tick(deps).catch(() => {}); }, intervalMs);
  h.unref?.();
  return () => clearInterval(h);
}
