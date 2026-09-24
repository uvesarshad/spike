/* The suite/replay runner behind the MCP `tests_run` tool (A4): pick saved
 * tests by name, tag, or all; run them ($0 replay for recorded scripts, an AI
 * pass for plain-English cases); return per-test verdicts + one aggregate.
 * Engine calls are injected (`replay`, `runCase`) so it is testable offline. */

import { applyExpectation, resolveSuite, skipsForMissingAuth, type SuiteCase, type SuiteEntry, type SuiteFileConfig } from './config.js';
import { filterByTags, runSuite, worstVerdict, type Verdict } from './runner.js';
import type { Report } from '../report/report.js';
import path from 'node:path';

export type SuiteItem = { kind: 'case'; value: SuiteCase } | { kind: 'entry'; value: SuiteEntry };

/** Give every case and entry a unique display label — what the runner, the
 * reporters and the exit-code roll-up all key on. */
export function labelSuiteItems(cases: SuiteCase[], entries: SuiteEntry[]): Map<string, SuiteItem> {
  const items = new Map<string, SuiteItem>();
  const scriptNames = new Set(entries.map((e) => e.script));
  for (const c of cases) {
    let label = scriptNames.has(c.name) || items.has(c.name) ? `case: ${c.name}` : c.name;
    while (items.has(label)) label = `${label}'`;
    items.set(label, { kind: 'case', value: c });
  }
  for (const e of entries) {
    let label = e.script;
    while (items.has(label)) label = `${label}'`;
    items.set(label, { kind: 'entry', value: e });
  }
  return items;
}

export interface TestsRunInput {
  name?: string;
  tag?: string;
  all?: boolean;
  url?: string;
  heal?: boolean;
  budgetUsd?: number;
}

/** Exactly one of name / tag / all. Returns an error string, or undefined. */
export function validateTestsRunInput(i: TestsRunInput): string | undefined {
  const given = [i.name !== undefined && i.name !== '', i.tag !== undefined && i.tag !== '', i.all === true].filter(Boolean).length;
  if (given !== 1) return 'Supply exactly one of: name (one saved test), tag (every test with that tag), or all: true.';
  if (i.url !== undefined) {
    try {
      new URL(i.url);
    } catch {
      return 'url must be a full address such as http://localhost:3000.';
    }
  }
  return undefined;
}

export interface TestsRunDeps {
  suite?: () => SuiteFileConfig;
  replay: (script: string, o: { heal: boolean; url?: string; spendCapUsd?: number }) => Promise<Report>;
  runCase: (c: SuiteCase, o: { url: string; spendCapUsd?: number }) => Promise<Report>;
  storageState?: string;
}

export interface TestsRunResult {
  verdict: Verdict;
  passed: number;
  total: number;
  tests: { test: string; verdict: Verdict; reason?: string; fix_hint?: string }[];
  summary: string;
}

const MAX_LISTED = 30;
const clip = (s: string | undefined, n = 200) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);

export async function runTests(input: TestsRunInput, deps: TestsRunDeps, fixHint: (r: Report) => string | undefined = () => undefined): Promise<TestsRunResult> {
  const bad = validateTestsRunInput(input);
  if (bad) throw new Error(bad);
  const suite = (deps.suite ?? (() => resolveSuite()))();
  const hasAuth = Boolean(deps.storageState);
  const casePick = skipsForMissingAuth(suite.cases, hasAuth);
  const entryPick = skipsForMissingAuth(suite.entries, hasAuth);
  const items = labelSuiteItems(casePick.run, entryPick.run);

  let list: SuiteEntry[] = [...items].map(([label, item]) => ({ script: label, ...(item.value.tags && { tags: item.value.tags }) }));
  if (input.tag) list = filterByTags(list, [input.tag]);
  if (input.name) {
    const want = input.name.trim();
    const base = (s: string) => path.basename(s).replace(/\.json$/i, '');
    list = list.filter((e) => e.script === want || base(e.script) === want || (items.get(e.script)?.value as { name?: string })?.name === want);
    // Not in the suite: a recorded script by that name can still be replayed.
    if (!list.length) {
      list = [{ script: want }];
    }
  }
  if (!list.length) {
    return { verdict: 'uncertain', passed: 0, total: 0, tests: [], summary: 'No saved tests matched — nothing was run.' };
  }

  let spent = 0;
  const budget = input.budgetUsd;
  const remaining = () => (budget === undefined ? undefined : Math.max(0, budget - spent));
  const hints = new Map<string, string>();
  const reasons = new Map<string, string>();

  const outcome = await runSuite(
    list,
    async (label) => {
      const rem = remaining();
      if (rem !== undefined && rem <= 0) {
        reasons.set(label, 'stopped: budget reached');
        return { verdict: 'uncertain' as Verdict };
      }
      const item = items.get(label);
      let report: Report;
      let verdict: Verdict;
      if (!item || item.kind === 'entry') {
        report = await deps.replay(item ? (item.value as SuiteEntry).script : label, {
          heal: input.heal === true,
          ...(input.url && { url: input.url }),
          ...(rem !== undefined && { spendCapUsd: rem }),
        });
        verdict = report.verdict;
      } else {
        report = await deps.runCase(item.value, { url: input.url ?? item.value.url, ...(rem !== undefined && { spendCapUsd: rem }) });
        verdict = applyExpectation(report.verdict, item.value.expect);
      }
      spent += report.spendSummary?.estimatedUsd ?? 0;
      if (report.reason) reasons.set(label, report.reason);
      const h = fixHint(report);
      if (h) hints.set(label, h);
      return { verdict };
    },
  );

  const results = outcome.results;
  const tests = results
    .map((r) => ({
      test: r.script,
      verdict: r.verdict,
      ...(r.verdict !== 'pass' && { reason: clip(r.error ?? reasons.get(r.script)) }),
      ...(hints.get(r.script) && { fix_hint: clip(hints.get(r.script), 400) }),
    }))
    .sort((a, b) => Number(a.verdict === 'pass') - Number(b.verdict === 'pass'));
  const passed = results.filter((r) => r.verdict === 'pass').length;
  const verdict = worstVerdict(results.map((r) => r.verdict));
  const shown = tests.slice(0, MAX_LISTED);
  const extra = tests.length - shown.length;
  return {
    verdict,
    passed,
    total: results.length,
    tests: shown,
    summary: `${passed}/${results.length} passed${extra > 0 ? ` (${extra} more passing tests not listed)` : ''}.`,
  };
}
