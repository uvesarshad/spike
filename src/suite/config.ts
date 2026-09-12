/* Suite config — the missing "suite" concept (audit A12).
 *
 * Before this, `spike replay --all` was `listScripts()` (an UNORDERED
 * `fs.readdirSync`, recorder/script.ts:267-274 / see also A12's citation of
 * the old cli.ts) iterated serially. This file gives a suite two ways to be
 * defined:
 *
 *   1. An optional `spike.suite.json` at the repo root: an explicit, ORDERED
 *      list of entries (`{ script, tags?, needsAuth? }`) plus optional
 *      `setup`/`teardown` hook script names — run first/last, see runner.ts.
 *   2. No config file: every script under `generated-tests/` (via the
 *      existing `listScripts()`), sorted by basename — deterministic across
 *      platforms/filesystems, unlike raw readdir order.
 *
 * `script` on an entry (and `setup`/`teardown`) is whatever `qaReplay`/
 * `loadScript` already accept: a bare recorded-script name or a path to a
 * `generated-tests/*.json` file — this module does no resolution of its own,
 * it only orders/filters identifiers. Deliberately has zero browser-layer
 * dependency (no engine.ts, no ports/*) so it stays trivially unit-testable
 * and composes with whatever `runOne` a caller wires up (see runner.ts). */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { listScripts } from '../recorder/script.js';

export interface SuiteEntry {
  /** A recorded-script name or a path to a generated-tests/*.json file —
   * passed straight through to the caller-supplied `runOne` (typically
   * `qaReplay`), never resolved here. */
  script: string;
  tags?: string[];
  /** A22: CONSUMED (it used to be validated and read by nothing). True means
   * this test only makes sense signed in, so `spike suite` skips it — reporting
   * the skip out loud — unless the run supplies a storage state. */
  needsAuth?: boolean;
}

/** A22: a suite case anyone can hand-write — a name, a URL and a sentence.
 * Before this, a suite could only list ALREADY-RECORDED scripts (`entries`),
 * so authoring one meant recording every flow through the driver first and
 * there was no way to express "test this, here" in the file at all. Cases run
 * through `qaRun` (a real AI pass); entries still run through replay. */
export interface SuiteCase {
  /** Human label — what the report and the exit-code roll-up call this test. */
  name: string;
  url: string;
  /** What to test, in plain English — the same string `spike run` takes. */
  task: string;
  /** The verdict this case is EXPECTED to produce. Default 'pass'. 'fail' is
   * for a known-broken flow you want held red-side-up: the case counts as a
   * pass only while the flow keeps failing, and turns the suite red the moment
   * it starts passing (i.e. when someone fixes it and forgets this entry). */
  expect?: 'pass' | 'fail';
  tags?: string[];
  /** Same meaning as SuiteEntry.needsAuth — skipped without a storage state. */
  needsAuth?: boolean;
}

export interface SuiteFileConfig {
  entries: SuiteEntry[];
  /** Plain-English cases (A22). Always present after resolveSuite(), possibly
   * empty — a suite may be all entries, all cases, or a mix. */
  cases: SuiteCase[];
  /** Script name/path run once before any entry. A non-pass verdict
   * short-circuits the entries (see runner.ts's runSuite). */
  setup?: string;
  /** Script name/path run once after all entries (or after a short-circuit),
   * for cleanup — see runner.ts's runSuite for exactly when it fires. */
  teardown?: string;
}

const SuiteEntrySchema = z
  .object({
    script: z.string().min(1),
    tags: z.array(z.string()).optional(),
    needsAuth: z.boolean().optional(),
  })
  .strict();

const SuiteCaseSchema = z
  .object({
    name: z.string().min(1),
    url: z.string().min(1),
    task: z.string().min(1),
    expect: z.enum(['pass', 'fail']).optional(),
    tags: z.array(z.string()).optional(),
    needsAuth: z.boolean().optional(),
  })
  .strict();

/* Both lists are optional so a suite can be entirely hand-written cases, or
 * entirely recorded entries — but a file with NEITHER is a typo, not a valid
 * "run nothing" instruction, so it's rejected here rather than silently
 * running zero tests and exiting green. */
const SuiteFileConfigSchema = z
  .object({
    entries: z.array(SuiteEntrySchema).optional(),
    cases: z.array(SuiteCaseSchema).optional(),
    setup: z.string().min(1).optional(),
    teardown: z.string().min(1).optional(),
  })
  .strict()
  .refine((c) => (c.entries?.length ?? 0) + (c.cases?.length ?? 0) > 0, {
    message: 'needs at least one test: "cases" (name + url + task) and/or "entries" (recorded scripts)',
  });

export const SUITE_CONFIG_FILENAME = 'spike.suite.json';

export function suiteConfigPath(root = process.cwd()): string {
  return path.join(root, SUITE_CONFIG_FILENAME);
}

/** Parse+validate `spike.suite.json` at `root`. Returns `null` when the file
 * doesn't exist (the "no config" case — callers fall back to
 * `defaultEntries`). Throws a readable, path-prefixed error on malformed JSON
 * or a schema violation — same "fail loudly at load time" convention as
 * `recorder/schema.ts`'s `validateQaScript`, so a typo'd suite config doesn't
 * silently run zero scripts or blow up deep inside the runner. */
export function loadSuiteConfig(root = process.cwd()): SuiteFileConfig | null {
  const p = suiteConfigPath(root);
  if (!fs.existsSync(p)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    throw new Error(`malformed ${SUITE_CONFIG_FILENAME}: not valid JSON (${(err as Error).message})`);
  }
  const result = SuiteFileConfigSchema.safeParse(raw);
  if (!result.success) {
    const errs = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`invalid ${SUITE_CONFIG_FILENAME}:\n  ${errs.join('\n  ')}`);
  }
  // Normalize both lists to arrays so every caller can iterate unconditionally.
  return { ...result.data, entries: result.data.entries ?? [], cases: result.data.cases ?? [] };
}

/** A22: does this test need a signed-in session it wasn't given? `needsAuth`
 * used to be validated and then read by nothing at all — a suite author could
 * mark a flow "needs a login" and watch it run anyway and fail. A test that
 * needs auth and has no storage state is SKIPPED (reported, not silently
 * dropped) rather than run into a guaranteed failure. */
export function skipsForMissingAuth<T extends { needsAuth?: boolean }>(items: T[], hasStorageState: boolean): { run: T[]; skipped: T[] } {
  if (hasStorageState) return { run: items, skipped: [] };
  return { run: items.filter((i) => !i.needsAuth), skipped: items.filter((i) => Boolean(i.needsAuth)) };
}

/** A22: a case's EFFECTIVE verdict, i.e. what it should contribute to the
 * suite's exit code. `expect` defaults to 'pass', so the common case is the
 * identity. With `expect: 'fail'` the polarity flips: the known-broken flow
 * failing IS the pass, and it going green means the file is now lying about
 * the app (someone fixed it and left the entry behind), which must be loud. */
export function applyExpectation(actual: 'pass' | 'fail' | 'uncertain', expect: 'pass' | 'fail' = 'pass'): 'pass' | 'fail' | 'uncertain' {
  if (expect === 'pass') return actual;
  if (actual === 'fail') return 'pass';
  if (actual === 'pass') return 'fail';
  return 'uncertain'; // "couldn't tell" is never evidence that a flow is still broken
}

/** Deterministic default ordering when no `spike.suite.json` exists: every
 * script under generated-tests/ (via the existing `listScripts()`), sorted by
 * basename. `fs.readdirSync` order is filesystem/platform-dependent — this is
 * what makes `replay --all` reproducible without a config file. */
export function defaultEntries(root = process.cwd()): SuiteEntry[] {
  const scripts = listScripts(root);
  return [...scripts].sort((a, b) => path.basename(a).localeCompare(path.basename(b))).map((script) => ({ script }));
}

/** The single entry point callers use: config-driven entries (in the file's
 * own order — that IS the ordering contract for a configured suite) when
 * `spike.suite.json` exists, else the sorted directory listing. */
export function resolveSuite(root = process.cwd()): SuiteFileConfig {
  const config = loadSuiteConfig(root);
  if (config) return config;
  return { entries: defaultEntries(root), cases: [] };
}
