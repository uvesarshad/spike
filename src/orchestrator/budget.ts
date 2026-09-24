/* A8 (P1) — spend accounting for anything that runs many runs in a row.
 *
 * One `SpendBudget` per batch (a fan-out, a suite, a scheduled job). Each
 * finished run's `spendSummary` is added to it; before starting the next run
 * the caller asks `exhausted()`, and hands `remaining()` to the run as its own
 * per-run cap so a single runaway flow also stops.
 *
 * Prices are estimates (see SpendSummary.estimatedUsd). Calls whose price
 * isn't known (subscription CLIs) add nothing to the dollar figure — they are
 * COUNTED and shown (`paidCalls`), never capped.
 */

import fs from 'node:fs';
import path from 'node:path';

/** The slice of a run's spendSummary the budget needs. */
export interface SpendLike {
  estimatedUsd?: number;
  paidCalls?: number;
  freeCalls?: number;
}

export interface SpendTotals {
  estimatedUsd: number;
  paidCalls: number;
  freeCalls: number;
  budgetUsd?: number;
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export class SpendBudget {
  private usd = 0;
  private paid = 0;
  private free = 0;
  constructor(readonly capUsd?: number) {}

  add(s: SpendLike | undefined): void {
    if (!s) return;
    this.usd += s.estimatedUsd ?? 0;
    this.paid += s.paidCalls ?? 0;
    this.free += s.freeCalls ?? 0;
  }

  get spentUsd(): number {
    return this.usd;
  }

  /** Dollars left for the next run, or undefined when there is no cap. Never negative. */
  remaining(): number | undefined {
    return this.capUsd === undefined ? undefined : Math.max(0, this.capUsd - this.usd);
  }

  exhausted(): boolean {
    return this.capUsd !== undefined && this.usd >= this.capUsd;
  }

  /** The plain reason shown on every flow that was skipped. */
  stopReason(): string {
    return `stopped: spending limit reached (${formatUsd(this.usd)} of ${formatUsd(this.capUsd ?? 0)})`;
  }

  totals(): SpendTotals {
    return { estimatedUsd: this.usd, paidCalls: this.paid, freeCalls: this.free, ...(this.capUsd !== undefined && { budgetUsd: this.capUsd }) };
  }
}

/** Parse a `--budget` value: a positive number of dollars, else an error the
 * CLI prints. Undefined in, undefined out. */
export function parseBudgetFlag(v: string | number | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--budget must be a positive dollar amount, like --budget 2 (got "${v}").`);
  return n;
}

/** The cap for something nobody is watching. An explicit budget always wins;
 * otherwise the configured default. Interactive runs never call this. */
export function resolveUnattendedBudget(explicit: number | undefined, cfg: { unattendedBudgetUsd?: number }): number | undefined {
  return explicit ?? cfg.unattendedBudgetUsd;
}
export function resolveCiBudget(explicit: number | undefined, cfg: { ciBudgetUsd?: number }): number | undefined {
  return explicit ?? cfg.ciBudgetUsd;
}

/** Sum `spendSummary.estimatedUsd` over the reports written under an artifacts
 * folder since `sinceMs` — how the scheduler learns what a child `spike`
 * process actually spent, whatever command it ran. */
export function spendSince(artifactsDir: string, sinceMs: number): SpendTotals {
  const t: SpendTotals = { estimatedUsd: 0, paidCalls: 0, freeCalls: 0 };
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(artifactsDir, { withFileTypes: true });
  } catch {
    return t;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(artifactsDir, e.name, 'report.json');
    try {
      if (fs.statSync(p).mtimeMs < sinceMs) continue;
      const s = (JSON.parse(fs.readFileSync(p, 'utf8')) as { spendSummary?: SpendLike }).spendSummary;
      t.estimatedUsd += s?.estimatedUsd ?? 0;
      t.paidCalls += s?.paidCalls ?? 0;
      t.freeCalls += s?.freeCalls ?? 0;
    } catch {
      /* unreadable report — skip */
    }
  }
  return t;
}
