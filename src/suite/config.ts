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
  needsAuth?: boolean;
}

export interface SuiteFileConfig {
  entries: SuiteEntry[];
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

const SuiteFileConfigSchema = z
  .object({
    entries: z.array(SuiteEntrySchema),
    setup: z.string().min(1).optional(),
    teardown: z.string().min(1).optional(),
  })
  .strict();

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
  return result.data;
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
  return { entries: defaultEntries(root) };
}
