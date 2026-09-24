import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { listRunSummaries, loadRunReport } from '../report/run-store.js';
import { acceptHeal, quarantineTest, rejectHeal, releaseTest } from '../recorder/tests-admin.js';
import { saveScript, scriptFromReport } from '../recorder/script.js';
import { runJob, type SchedulerDeps } from '../schedule/scheduler.js';
import { childRunner } from '../schedule/job-runner.js';
import type { JobStore } from '../schedule/store.js';

/* The things Spike home can DO (A12). Each is a small function over an explicit
 * root / artifacts dir / store, so tests pass temp dirs and stubs. The server
 * only dispatches to these after the Host guard and the per-process token. QA
 * only (decision 1): nothing here edits the user's source code. */

export class ActionError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface ActivityEntry {
  id: number;
  label: string;
  state: 'running' | 'done';
  verdict?: string;
  runId?: string;
  summary?: string;
  startedAt: number;
}

export interface ActivityResult {
  verdict?: string;
  runId?: string;
  summary?: string;
}

/** What is running now / finished lately. One at a time: two Chromes fighting over one profile helps nobody. */
export class Activity {
  private entries: ActivityEntry[] = [];
  private nextId = 1;

  get busy(): boolean {
    return this.entries.some((e) => e.state === 'running');
  }

  list(): ActivityEntry[] {
    return this.entries.slice(-8);
  }

  track(label: string, work: () => Promise<ActivityResult>): ActivityEntry {
    if (this.busy) throw new ActionError('Something is already running — wait for it to finish.', 409);
    const entry: ActivityEntry = { id: this.nextId++, label, state: 'running', startedAt: Date.now() };
    this.entries.push(entry);
    work().then(
      (r) => Object.assign(entry, r, { state: 'done' as const }),
      (e: unknown) => Object.assign(entry, { state: 'done' as const, verdict: 'uncertain', summary: e instanceof Error ? e.message : String(e) }),
    );
    return entry;
  }
}

/** Runs `spike <args>` and resolves with the exit code. Injectable so tests never spawn. */
export type CliRunner = (args: string[]) => Promise<{ code: number }>;

export function realCliRunner(cliPath: string, cwd: string): CliRunner {
  return (args) =>
    new Promise((resolve) => {
      execFile(process.execPath, [cliPath, ...args], { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 60 * 60_000 }, (err) => {
        const c = err ? (err as unknown as { code?: unknown }).code : 0;
        resolve({ code: typeof c === 'number' ? c : 3 });
      });
    });
}

export const verdictForExit = (code: number): string => (code === 0 ? 'pass' : code === 1 ? 'fail' : 'uncertain');

export interface DashboardActions {
  rerun(body: { runId?: unknown }): Promise<Record<string, unknown>> | Record<string, unknown>;
  'save-test'(body: { runId?: unknown }): Promise<Record<string, unknown>> | Record<string, unknown>;
  'run-all'(body: object): Promise<Record<string, unknown>> | Record<string, unknown>;
  'accept-heal'(body: { name?: unknown }): Promise<Record<string, unknown>> | Record<string, unknown>;
  'reject-heal'(body: { name?: unknown }): Promise<Record<string, unknown>> | Record<string, unknown>;
  quarantine(body: { name?: unknown }): Promise<Record<string, unknown>> | Record<string, unknown>;
  release(body: { name?: unknown }): Promise<Record<string, unknown>> | Record<string, unknown>;
  'run-now'(body: { id?: unknown }): Promise<Record<string, unknown>> | Record<string, unknown>;
  'remove-job'(body: { id?: unknown }): Promise<Record<string, unknown>> | Record<string, unknown>;
  'test-something'(body: { url?: unknown; task?: unknown; spec?: unknown }): Promise<Record<string, unknown>> | Record<string, unknown>;
}

export interface ActionDeps {
  root: string;
  artifactsDir: string;
  jobStore: Pick<JobStore, 'list' | 'get' | 'remove' | 'update'>;
  defaultBudgetUsd?: number;
  activity: Activity;
  /** Undefined when Spike home has no way to start a run (no CLI path known). */
  cli?: CliRunner;
  /** Path of the `spike` CLI entry, for jobs that run as a child process. */
  cliPath?: string;
  /** Test seam for "Run now" — defaults to the real child-process job runner. */
  jobRunner?: SchedulerDeps['run'];
}

const str = (v: unknown, what: string, max = 500): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new ActionError(`Missing or invalid ${what}.`);
  return v.trim();
};

const needCli = (d: ActionDeps): CliRunner => {
  if (!d.cli) throw new ActionError('This page cannot start a run from here — use the command line.', 501);
  return d.cli;
};

/** Track a `spike <args>` child run; when it ends, link the newest run it wrote. */
function startCli(d: ActionDeps, label: string, args: string[]): Record<string, unknown> {
  const cli = needCli(d);
  const since = Date.now() - 1000;
  const e = d.activity.track(label, async () => {
    const { code } = await cli(args);
    const newest = listRunSummaries(d.artifactsDir).find((r) => r.mtimeMs >= since);
    return { verdict: verdictForExit(code), ...(newest && { runId: newest.runId }) };
  });
  return { ok: true, started: e.id };
}

function httpUrl(v: unknown): string {
  const raw = str(v, 'site address', 2000);
  let u: URL;
  try { u = new URL(raw); } catch { throw new ActionError('That does not look like a site address (try https://…).'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ActionError('Only http:// or https:// addresses can be tested.');
  return u.toString();
}

export function defaultActions(d: ActionDeps): DashboardActions {
  const known = (name: unknown): string => str(name, 'test name', 200);
  return {
    rerun: (b) => {
      const runId = str(b.runId, 'run');
      const r = loadRunReport(d.artifactsDir, runId);
      if (!r) throw new ActionError('That run was not found.', 404);
      return startCli(d, `Re-running "${r.task.slice(0, 60)}"`, ['run', r.task, '--url', r.url, '--headless', '--json']);
    },
    'save-test': (b) => {
      const r = loadRunReport(d.artifactsDir, str(b.runId, 'run'));
      if (!r) throw new ActionError('That run was not found.', 404);
      try {
        const { jsonPath } = saveScript(scriptFromReport(r), d.root);
        return { ok: true, saved: path.basename(jsonPath) };
      } catch (e) {
        throw new ActionError(e instanceof Error ? e.message : String(e));
      }
    },
    'run-all': () => startCli(d, 'Running all saved tests', ['suite', '--headless', '--json']),
    'accept-heal': (b) => { acceptHeal(known(b.name), d.root); return { ok: true }; },
    'reject-heal': (b) => { rejectHeal(known(b.name), d.root); return { ok: true }; },
    quarantine: (b) => { quarantineTest(known(b.name), 'parked from Spike home', d.root); return { ok: true }; },
    release: (b) => { releaseTest(known(b.name), d.root); return { ok: true }; },
    'remove-job': (b) => {
      if (!d.jobStore.remove(str(b.id, 'job', 40))) throw new ActionError('That scheduled test was not found.', 404);
      return { ok: true };
    },
    'run-now': (b) => {
      const job = d.jobStore.get(str(b.id, 'job', 40));
      if (!job) throw new ActionError('That scheduled test was not found.', 404);
      const runner = d.jobRunner ?? (d.cliPath ? childRunner(d.cliPath, d.root) : undefined);
      if (!runner) needCli(d);
      const e = d.activity.track(`Running ${job.kind}${job.target ? `: ${job.target}` : ''} now`, async () => {
        const res = await runJob(job, { store: d.jobStore as JobStore, run: runner!, defaultBudgetUsd: d.defaultBudgetUsd });
        return { verdict: res.verdict, ...(res.runId && { runId: res.runId }), ...(res.summary && { summary: res.summary }) };
      });
      return { ok: true, started: e.id };
    },
    'test-something': (b) => {
      const url = httpUrl(b.url);
      const hasSpec = typeof b.spec === 'string' && b.spec.trim() !== '';
      if (hasSpec) {
        const spec = b.spec as string;
        if (spec.length > 200_000) throw new ActionError('That spec file is too big (200 KB limit).');
        const dir = path.join(d.root, '.spike', 'dashboard-specs');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `spec-${Date.now()}.md`);
        fs.writeFileSync(file, spec);
        return startCli(d, 'Testing your spec file', ['run', '--spec', file, '--url', url, '--headless', '--json']);
      }
      const task = str(b.task, 'sentence describing what to test', 2000);
      if (task.startsWith('-')) throw new ActionError('Describe what to test in a sentence.');
      return startCli(d, `Testing: ${task.slice(0, 60)}`, ['run', task, '--url', url, '--headless', '--json']);
    },
  };
}
