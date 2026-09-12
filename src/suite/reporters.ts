/* Suite reporters — the machine-readable half of A12/A15: "no CI config, no
 * test runner" (A15) and "no suite orchestration... machine-readable suite
 * report" (A12). A repo-wide grep confirms no JUnit output exists anywhere
 * today — this is the first. Both reporters are pure functions over a
 * `SuiteRunOutcome` (see runner.ts) so they're testable with zero browser/
 * model dependency. The one impure function is `writeSuiteReport` at the
 * bottom: the single place a report reaches disk, shared by `spike suite` and
 * `spike replay --all`. It lives here rather than in cli.ts so that "--reporter
 * json --out really does produce a file" is a fast-suite assertion — A22's
 * actual bug was that the flag was accepted, wired to nothing, and a CI job
 * asking for a JSON artifact got no file and a green step. */

import fs from 'node:fs';
import path from 'node:path';
import type { SuiteRunOutcome, SuiteScriptResult, Verdict } from './runner.js';

/* ---------- JSON summary ---------- */

export interface SuiteJsonCase {
  script: string;
  tags?: string[];
  verdict: Verdict;
  durationMs: number;
  error?: string;
}

export interface SuiteJsonSummary {
  worst: 0 | 1 | 2;
  shortCircuited: boolean;
  setup?: SuiteJsonCase;
  teardown?: SuiteJsonCase;
  results: SuiteJsonCase[];
}

function toJsonCase(r: SuiteScriptResult): SuiteJsonCase {
  return {
    script: r.script,
    ...(r.tags && r.tags.length ? { tags: r.tags } : {}),
    verdict: r.verdict,
    durationMs: r.durationMs,
    ...(r.error ? { error: r.error } : {}),
  };
}

/** A richer, additive JSON shape for `--reporter json --out <path>` — this is
 * NOT the shape `spike replay --all --json` prints to stdout (that array of
 * `{script, healed, ...slimReport(report)}` objects is a public contract
 * cli.ts preserves unchanged); this is the new suite-level summary (worst
 * exit code, setup/teardown, per-entry pass/fail/duration) for a CI artifact. */
export function buildJsonSummary(outcome: SuiteRunOutcome): SuiteJsonSummary {
  return {
    worst: outcome.worst,
    shortCircuited: outcome.shortCircuited,
    ...(outcome.setup ? { setup: toJsonCase(outcome.setup) } : {}),
    ...(outcome.teardown ? { teardown: toJsonCase(outcome.teardown) } : {}),
    results: outcome.results.map(toJsonCase),
  };
}

/* ---------- JUnit XML ---------- */

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function caseXml(r: SuiteScriptResult): string {
  const name = xmlEscape(r.script);
  const time = (r.durationMs / 1000).toFixed(3);
  if (r.verdict === 'pass') {
    return `    <testcase name="${name}" time="${time}"/>`;
  }
  // `uncertain` has no JUnit-native equivalent — CI consumers only understand
  // pass/fail/skipped, and "the tool couldn't tell" should still turn the
  // build red rather than silently read as green, so it's emitted as a
  // <failure> too, distinguished only by its message text.
  const message = xmlEscape(r.error ?? `verdict: ${r.verdict}`);
  return `    <testcase name="${name}" time="${time}">\n      <failure message="${message}">${message}</failure>\n    </testcase>`;
}

/** Render a `SuiteRunOutcome` as a single-`<testsuite>` JUnit XML document —
 * one `<testcase>` per entry (plus setup/teardown, if configured), `<failure>`
 * on anything that isn't `pass`. Drops into any CI that reads JUnit (GitHub
 * Actions, GitLab, Jenkins, …) with zero repo-specific tooling on the CI side. */
export function buildJUnitXml(outcome: SuiteRunOutcome, suiteName = 'spike replay'): string {
  const cases: SuiteScriptResult[] = [
    ...(outcome.setup ? [{ ...outcome.setup, script: `setup: ${outcome.setup.script}` }] : []),
    ...outcome.results,
    ...(outcome.teardown ? [{ ...outcome.teardown, script: `teardown: ${outcome.teardown.script}` }] : []),
  ];
  const failures = cases.filter((c) => c.verdict !== 'pass').length;
  const totalTimeSec = cases.reduce((sum, c) => sum + c.durationMs, 0) / 1000;
  const body = cases.map(caseXml).join('\n');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites>\n` +
    `  <testsuite name="${xmlEscape(suiteName)}" tests="${cases.length}" failures="${failures}" time="${totalTimeSec.toFixed(3)}">\n` +
    `${body}\n` +
    `  </testsuite>\n` +
    `</testsuites>\n`
  );
}

/* ---------- writing one to disk ---------- */

export type SuiteReporterId = 'json' | 'junit';

export const SUITE_REPORTERS: SuiteReporterId[] = ['json', 'junit'];

export function isSuiteReporter(value: string): value is SuiteReporterId {
  return (SUITE_REPORTERS as string[]).includes(value);
}

/** Render `outcome` with the named reporter and write it to `outPath`,
 * creating parent directories (a CI job almost always points --out at a
 * not-yet-existing artifacts directory). Returns the path written, so a caller
 * can say so. */
export function writeSuiteReport(outcome: SuiteRunOutcome, reporter: SuiteReporterId, outPath: string, suiteName = 'spike suite'): string {
  const body = reporter === 'junit' ? buildJUnitXml(outcome, suiteName) : `${JSON.stringify(buildJsonSummary(outcome), null, 2)}\n`;
  const dir = path.dirname(path.resolve(outPath));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outPath, body);
  return outPath;
}
