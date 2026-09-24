/* A7 — the real job runner: runs the job as a child `spike` command (same
 * binary that is running now) and maps its exit code to a verdict. Kept out
 * of the scheduler so tests never launch Chrome. */

import { execFile } from 'node:child_process';
import type { Job } from './store.js';
import type { JobResult } from './scheduler.js';

export function jobArgs(job: Job): string[] {
  switch (job.kind) {
    case 'suite': return ['suite', '--headless', '--json'];
    case 'tag': return ['suite', '--tag', job.target, '--headless', '--json'];
    case 'check': return ['check', job.url, '--headless', '--json'];
    case 'spec': return ['run', '--spec', job.target, '--url', job.url, '--headless', '--json'];
  }
}

export function verdictForExit(code: number): JobResult['verdict'] {
  return code === 0 ? 'pass' : code === 1 ? 'fail' : 'uncertain';
}

export function childRunner(cliPath: string, cwd?: string): (job: Job) => Promise<JobResult> {
  return (job) => new Promise((resolve) => {
    execFile(process.execPath, [cliPath, ...jobArgs(job)], { ...(cwd && { cwd }), maxBuffer: 64 * 1024 * 1024, timeout: 60 * 60_000 }, (err) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : 3) : 0;
      const verdict = verdictForExit(code);
      resolve({ verdict, summary: verdict === 'pass' ? 'all passing' : verdict === 'fail' ? 'something is broken' : 'could not decide' });
    });
  });
}
