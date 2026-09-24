/* A7 — the scheduled-job store: ~/.spike/jobs.json (0600). The home directory
 * is injectable so tests never touch the real one. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseWhen } from './when.js';

export type JobKind = 'suite' | 'tag' | 'check' | 'spec';

export interface Job {
  id: string;
  kind: JobKind;
  /** tag name (kind tag), spec file (kind spec); '' otherwise. */
  target: string;
  url: string;
  when: string;
  budgetUsd?: number;
  webhook?: string;
  createdAt: number;
  lastRunAt: number | null;
  lastVerdict: 'pass' | 'fail' | 'uncertain' | null;
  lastRunId?: string;
  lastSummary?: string;
  /** Estimated dollars spent since `spendWindowStart` (a 24 h window). Kept under
   * its old name; the window is rolling, not a calendar day. */
  spentTodayUsd: number;
  /** When the current 24 h spend window began (ms). Absent = no spend yet. */
  spendWindowStart?: number;
}

export const SPEND_WINDOW_MS = 24 * 60 * 60_000;

/** Dollars spent in the current 24 h window as of `now`. */
export function spentInWindow(job: Pick<Job, 'spentTodayUsd' | 'spendWindowStart'>, now: number): number {
  return job.spendWindowStart !== undefined && now - job.spendWindowStart < SPEND_WINDOW_MS ? job.spentTodayUsd : 0;
}

/** `suite` | `tag:<t>` | `check` | `spec:<file>` → kind + target. */
export function parseTarget(raw: string): { kind: JobKind; target: string } {
  if (raw === 'suite') return { kind: 'suite', target: '' };
  if (raw === 'check') return { kind: 'check', target: '' };
  if (raw.startsWith('tag:') && raw.length > 4) return { kind: 'tag', target: raw.slice(4) };
  if (raw.startsWith('spec:') && raw.length > 5) return { kind: 'spec', target: raw.slice(5) };
  throw new Error(`I do not know what "${raw}" is. Use: suite, tag:<name>, check, or spec:<file>.`);
}

export class JobStore {
  readonly file: string;
  constructor(opts: { home?: string } = {}) {
    this.file = path.join(opts.home ?? os.homedir(), '.spike', 'jobs.json');
  }

  list(): Job[] {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(j) ? (j as Job[]) : [];
    } catch {
      return [];
    }
  }

  private write(jobs: Job[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* best effort (Windows) */ }
  }

  add(input: { target: string; url: string; when: string; budgetUsd?: number; webhook?: string }, now = Date.now()): Job {
    parseWhen(input.when); // throws a readable error
    const { kind, target } = parseTarget(input.target);
    const job: Job = {
      id: crypto.randomBytes(3).toString('hex'),
      kind, target, url: input.url, when: input.when, createdAt: now,
      lastRunAt: null, lastVerdict: null, spentTodayUsd: 0,
      ...(input.budgetUsd !== undefined && { budgetUsd: input.budgetUsd }),
      ...(input.webhook && { webhook: input.webhook }),
    };
    this.write([...this.list(), job]);
    return job;
  }

  remove(id: string): boolean {
    const jobs = this.list();
    const rest = jobs.filter((j) => j.id !== id);
    if (rest.length === jobs.length) return false;
    this.write(rest);
    return true;
  }

  get(id: string): Job | undefined {
    return this.list().find((j) => j.id === id);
  }

  update(id: string, patch: Partial<Job>): void {
    this.write(this.list().map((j) => (j.id === id ? { ...j, ...patch } : j)));
  }
}
