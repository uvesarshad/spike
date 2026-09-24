/* A7 — the daemon's scheduler. tick() runs every due job, one at a time.
 * The runner, clock and notifier are injected so tests use fakes. */

import { JobStore, localDay, type Job } from './store.js';
import { isDue } from './when.js';
import { notifyIfFlipped, type StatusChange, type Verdict } from './notify.js';

export interface JobResult {
  verdict: Verdict;
  runId?: string;
  costUsd?: number;
  summary?: string;
}

export type JobRunner = (job: Job) => Promise<JobResult>;
export type StatusNotifier = (prev: Verdict | null, change: StatusChange, webhook?: string) => Promise<unknown>;

export interface SchedulerDeps {
  store: JobStore;
  run: JobRunner;
  now?: () => number;
  notify?: StatusNotifier;
}

/** Run one job now (used by tick and `schedule run-now`); records the result. */
export async function runJob(job: Job, deps: SchedulerDeps): Promise<JobResult> {
  const now = (deps.now ?? Date.now)();
  const today = localDay(now);
  const spentBefore = job.spendDay === today ? job.spentTodayUsd : 0;
  let result: JobResult;
  if (job.budgetUsd !== undefined && spentBefore >= job.budgetUsd) {
    result = { verdict: 'uncertain', summary: 'stopped: budget reached for today' };
  } else {
    try {
      result = await deps.run(job);
    } catch (e) {
      result = { verdict: 'uncertain', summary: `could not run: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  const finished = (deps.now ?? Date.now)();
  deps.store.update(job.id, {
    lastRunAt: finished,
    lastVerdict: result.verdict,
    lastRunId: result.runId,
    lastSummary: result.summary,
    spendDay: today,
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
