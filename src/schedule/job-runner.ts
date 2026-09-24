/* A7 — the real job runner: runs the job as a child `spike` command (same
 * binary that is running now) and maps its exit code to a verdict. Kept out
 * of the scheduler so tests never launch Chrome. */

import path from 'node:path';
import { execFile } from 'node:child_process';
import { spendSince } from '../orchestrator/budget.js';
import type { Job } from './store.js';
import type { JobResult } from './scheduler.js';

/** The child command for a job. `budgetUsd` (A8) is what it may still spend. */
export function jobArgs(job: Job, budgetUsd?: number): string[] {
  const budget = budgetUsd !== undefined ? ['--budget', String(Math.max(budgetUsd, 0.01).toFixed(2))] : [];
  switch (job.kind) {
    case 'suite': return ['suite', '--headless', '--json', ...budget];
    case 'tag': return ['suite', '--tag', job.target, '--headless', '--json', ...budget];
    case 'check': return ['check', job.url, '--headless', '--json', ...budget];
    case 'spec': return ['run', '--spec', job.target, '--url', job.url, '--headless', '--json', ...budget];
  }
}

export function verdictForExit(code: number): JobResult['verdict'] {
  return code === 0 ? 'pass' : code === 1 ? 'fail' : 'uncertain';
}

export function childRunner(cliPath: string, cwd?: string): (job: Job, ctx?: { budgetUsd?: number }) => Promise<JobResult> {
  return (job, ctx) => new Promise((resolve) => {
    const startedAt = Date.now() - 1000;
    const artifacts = process.env.SPIKE_ARTIFACTS_DIR ?? path.resolve(cwd ?? process.cwd(), 'artifacts');
    execFile(process.execPath, [cliPath, ...jobArgs(job, ctx?.budgetUsd)], { ...(cwd && { cwd }), maxBuffer: 64 * 1024 * 1024, timeout: 60 * 60_000 }, (err) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : 3) : 0;
      const verdict = verdictForExit(code);
      // A8: what the child really spent = the spend in the reports it wrote.
      const spent = spendSince(artifacts, startedAt).estimatedUsd;
      resolve({ verdict, costUsd: spent, summary: verdict === 'pass' ? 'all passing' : verdict === 'fail' ? 'something is broken' : 'could not decide' });
    });
  });
}
