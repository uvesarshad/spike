/* Suite runner — the orchestration `replay --all` never had (audit A12).
 *
 * Deliberately browser-layer-agnostic: every function here takes an injected
 * `RunOneFn` and never imports engine.ts/ports/* itself. That is what lets
 * `--workers N` exist today without this module knowing (or caring) whether
 * `runOne` drives one shared CDP session (today's behaviour, still the
 * default at workers=1) or a per-worker isolated Playwright BrowserContext
 * (the coordinator's `src/ports/playwright-browser.ts`, wired in later by
 * whoever owns that file — NOT imported here). */

import type { SuiteEntry } from './config.js';
export type { SuiteEntry } from './config.js';

export type Verdict = 'pass' | 'fail' | 'uncertain';

/** pass < fail < uncertain — mirrors the CLI's existing exit-code contract
 * (`cli.ts`: 0 pass / 1 fail / 2 uncertain), aggregated as `worst = max(...)`. */
export const VERDICT_RANK: Record<Verdict, 0 | 1 | 2> = { pass: 0, fail: 1, uncertain: 2 };

export function worstVerdict(verdicts: Verdict[]): Verdict {
  let worst: Verdict = 'pass';
  for (const v of verdicts) if (VERDICT_RANK[v] > VERDICT_RANK[worst]) worst = v;
  return worst;
}

export function worstExitCode(verdicts: Verdict[]): 0 | 1 | 2 {
  return VERDICT_RANK[worstVerdict(verdicts.length ? verdicts : ['pass'])];
}

/** What a caller's script-execution function returns. `verdict` is the only
 * field the runner reads; everything else (e.g. a full `Report`/
 * `QaReplayResult`) rides along in `SuiteScriptResult.result` for reporters
 * and CLI callers that want it (see cli.ts's `--json` wiring). */
export interface RunOneResult {
  verdict: Verdict;
  [key: string]: unknown;
}

export type RunOneFn = (scriptId: string) => Promise<RunOneResult>;

export interface SuiteScriptResult {
  script: string;
  tags?: string[];
  verdict: Verdict;
  durationMs: number;
  /** Set when `runOne` threw — the entry counts as `fail` for aggregation
   * (never a silent skip; a broken suite entry must show up in the exit
   * code, same spirit as A12's "no suite concept" gap this closes). */
  error?: string;
  /** Present unless `runOne` threw. */
  result?: RunOneResult;
}

export interface SuiteRunOptions {
  /** A11 (injected, not imported — keeps this module engine-free): decides
   * whether a script's result is excluded from the aggregate exit code. */
  isQuarantined?: (script: string) => boolean;
  /** Concurrency for the entries list. Default 1 — today's exact serial
   * behaviour, so `--workers` is opt-in and no caller gets surprise
   * parallelism just from upgrading. */
  workers?: number;
  /** Script name/path run once before any entry. A non-pass verdict
   * short-circuits the entries list (none of them run) — see `runSuite`. */
  setup?: string;
  /** Script name/path run once after the entries (whether they ran or were
   * short-circuited by a failing setup) — see `runSuite`. */
  teardown?: string;
  /** Fired the moment each ENTRY (not setup/teardown) finishes, in
   * completion order — which equals array order when workers=1. This is what
   * lets the CLI keep printing a script's result as soon as it's done,
   * matching today's serial print-as-you-go UX at the workers=1 default. */
  onResult?: (result: SuiteScriptResult, index: number) => void;
}

export interface SuiteRunOutcome {
  setup?: SuiteScriptResult;
  results: SuiteScriptResult[];
  teardown?: SuiteScriptResult;
  /** A11: scripts that ran and reported but were excluded from `worst`
   * because they are quarantined. Empty unless `isQuarantined` was supplied. */
  quarantined?: string[];
  /** worst verdict across setup + every entry + teardown, as the CLI exit code. */
  worst: 0 | 1 | 2;
  /** true when a failing/uncertain setup caused every entry to be skipped
   * (`results` is then empty). */
  shortCircuited: boolean;
}

async function runSingle(script: string, runOne: RunOneFn): Promise<SuiteScriptResult> {
  const start = Date.now();
  try {
    const result = await runOne(script);
    return { script, verdict: result.verdict, durationMs: Date.now() - start, result };
  } catch (e) {
    return { script, verdict: 'fail', durationMs: Date.now() - start, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Run `entries` with up to `opts.workers` (default 1) concurrent in-flight
 * `runOne` calls. A small worker-pool over a shared cursor, NOT
 * `Promise.all(entries.map(...))` — that would launch all of them at once
 * regardless of `workers`. Results land at their original array index
 * (`entries[i]` -> `results[i]`) regardless of completion order, so suite
 * ordering (config order, or the sorted default) is always what reporters and
 * `--json` see — only the WORK happens concurrently, never the reported
 * order. */
export async function runEntries(entries: SuiteEntry[], runOne: RunOneFn, opts: SuiteRunOptions = {}): Promise<SuiteScriptResult[]> {
  if (entries.length === 0) return [];
  const workers = Math.max(1, Math.floor(opts.workers ?? 1));
  const results: SuiteScriptResult[] = new Array(entries.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= entries.length) return;
      const entry = entries[i];
      const r = await runSingle(entry.script, runOne);
      const withTags: SuiteScriptResult = entry.tags ? { ...r, tags: entry.tags } : r;
      results[i] = withTags;
      opts.onResult?.(withTags, i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(workers, entries.length) }, () => worker()));
  return results;
}

/** Full suite execution: optional setup -> entries (concurrent per
 * `opts.workers`) -> optional teardown.
 *
 * Design choice on short-circuit: a failing/uncertain setup skips every
 * entry (there is no point driving 200 flows against a DB that was never
 * seeded) but teardown STILL runs — it is cleanup for whatever the setup
 * itself may have partially done (e.g. it created a tenant before the step
 * that failed), mirroring a try/finally rather than a plain early return. */
export async function runSuite(entries: SuiteEntry[], runOne: RunOneFn, opts: SuiteRunOptions = {}): Promise<SuiteRunOutcome> {
  let setup: SuiteScriptResult | undefined;
  let shortCircuited = false;

  if (opts.setup) {
    setup = await runSingle(opts.setup, runOne);
    if (setup.verdict !== 'pass') shortCircuited = true;
  }

  const results = shortCircuited ? [] : await runEntries(entries, runOne, opts);

  let teardown: SuiteScriptResult | undefined;
  if (opts.teardown) {
    teardown = await runSingle(opts.teardown, runOne);
  }

  // A11: a quarantined flow still RUNS and still REPORTS — it is simply
  // excluded from the aggregate exit code. That asymmetry is the point: a
  // known-flaky flow must not redden CI, but hiding it entirely would let it
  // rot unnoticed until someone deletes it. `isQuarantined` is injected rather
  // than imported so this module keeps its no-engine-dependency property (the
  // whole reason the runner takes `runOne` as a parameter).
  const counted = results.filter((r) => !opts.isQuarantined?.(r.script));
  const verdicts: Verdict[] = [
    ...(setup ? [setup.verdict] : []),
    ...counted.map((r) => r.verdict),
    ...(teardown ? [teardown.verdict] : []),
  ];
  const quarantined = results.filter((r) => opts.isQuarantined?.(r.script)).map((r) => r.script);

  return { setup, results, teardown, worst: worstExitCode(verdicts), shortCircuited, quarantined };
}

/* ---------- selection: --tag / --filter / --shard ---------- */

/** `--tag`: keep entries tagged with ANY of `tags` (OR match — a common CI
 * pattern: `--tag smoke --tag critical` runs either). Entries with no tags
 * never match a non-empty tag filter. `opts.tags` empty/undefined -> no-op. */
export function filterByTags(entries: SuiteEntry[], tags?: string[]): SuiteEntry[] {
  if (!tags || tags.length === 0) return entries;
  return entries.filter((e) => (e.tags ?? []).some((t) => tags.includes(t)));
}

/** `--filter`: keep entries whose `script` identifier contains `substr`
 * (plain substring — no regex surprises for a CLI flag). `substr` empty/
 * undefined -> no-op. */
export function filterByString(entries: SuiteEntry[], substr?: string): SuiteEntry[] {
  if (!substr) return entries;
  return entries.filter((e) => e.script.includes(substr));
}

export interface ShardSpec {
  /** 1-based shard index being run. */
  index: number;
  /** total shard count. */
  count: number;
}

/** Parse a `--shard i/N` value, e.g. `"2/4"`. 1-based `i`, `1 <= i <= N`. */
export function parseShard(spec: string): ShardSpec {
  const m = /^(\d+)\/(\d+)$/.exec(spec.trim());
  if (!m) throw new Error(`invalid --shard "${spec}" — expected "i/N", e.g. "1/4"`);
  const index = parseInt(m[1], 10);
  const count = parseInt(m[2], 10);
  if (count < 1) throw new Error(`invalid --shard "${spec}" — N must be >= 1`);
  if (index < 1 || index > count) throw new Error(`invalid --shard "${spec}" — i must be between 1 and ${count}`);
  return { index, count };
}

/** Deterministic partition by SORTED script name — independent of whatever
 * order `entries` arrives in (config order, or the already-sorted default),
 * so shard membership never depends on run-to-run ordering noise. Every
 * script lands in exactly one shard (`sortedIndex % N`) and every shard
 * 1..N together covers the input exactly once with no overlap, for any N.
 * The RETURNED subset preserves the input's original relative order (so a
 * sharded run still respects config-declared execution order, e.g. an auth
 * flow staying before the flows that depend on it). */
export function shardEntries(entries: SuiteEntry[], shard: ShardSpec): SuiteEntry[] {
  const sortedNames = [...entries].map((e) => e.script).sort((a, b) => a.localeCompare(b));
  const positionOf = new Map<string, number>();
  sortedNames.forEach((name, i) => {
    // first-seen position wins on a duplicate script id — duplicates are a
    // config authoring mistake, not this function's problem to solve.
    if (!positionOf.has(name)) positionOf.set(name, i);
  });
  return entries.filter((e) => positionOf.get(e.script)! % shard.count === shard.index - 1);
}
