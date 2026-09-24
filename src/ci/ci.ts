/* `spike ci` (A9): the unattended, pull-request front door. Wait for a preview
 * URL to come up, run the saved suite and/or a site check through the SAME
 * shared runners `tests_run` / `site_check` use, and roll everything into one
 * Markdown summary + one exit code. Browser/model work and the clock are
 * injected so the whole thing is testable offline. */

import fs from 'node:fs';
import path from 'node:path';
import { runSiteCheck, slimSiteCheck, SiteCheckError, type SiteCheckOptions, type SiteCheckResult } from '../discovery/run-check.js';
import { runTests, type TestsRunDeps, type TestsRunResult } from '../suite/run-tests.js';
import { worstVerdict, type Verdict } from '../suite/runner.js';
import { exitCodeForVerdict, INFRA_ERROR_EXIT_CODE } from '../cli-exit-codes.js';

export const DEFAULT_WAIT_MS = 180_000;
export const CI_COMMENT_MARKER = '<!-- spike-ci -->';

export interface CiOptions {
  url: string;
  /** Run the saved suite (all tests). */
  suite?: boolean;
  /** Also walk the site and look at each page. */
  check?: boolean;
  maxPages?: number;
  /** Total spend cap in USD across the whole run. */
  budgetUsd?: number;
  storageState?: string;
  /** Poll this address (default: `url`) until it answers 200. */
  waitForUrl?: string;
  waitMs?: number;
  headless?: boolean;
  progress?: (line: string) => void;
}

export interface CiDeps {
  fetchStatus?: (url: string) => Promise<number>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  testsDeps?: TestsRunDeps;
  runSuite?: (o: CiOptions, budgetUsd?: number) => Promise<TestsRunResult>;
  runCheck?: (o: CiOptions, budgetUsd?: number) => Promise<SiteCheckResult>;
}

export interface CiResult {
  url: string;
  verdict: Verdict;
  /** 0 pass / 1 fail / 2 uncertain / 3 the tool itself could not run. */
  exitCode: number;
  /** Set when nothing ran (URL never came up, nothing selected). */
  error?: string;
  suite?: TestsRunResult;
  check?: { verdict: Verdict; pagesChecked: number; problems: { page: string; what: string }[]; summary: string };
  budgetUsd?: number;
}

export class UrlWaitError extends Error {}

const defaultFetchStatus = async (url: string): Promise<number> => {
  try {
    return (await fetch(url, { redirect: 'follow' })).status;
  } catch {
    return 0;
  }
};

/** Poll until the address answers 200 (preview deploys lag the "deployed"
 * event). Throws UrlWaitError on timeout. */
export async function waitForUrl(url: string, deps: CiDeps = {}, timeoutMs = DEFAULT_WAIT_MS, intervalMs = 3000): Promise<void> {
  const fetchStatus = deps.fetchStatus ?? defaultFetchStatus;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const start = now();
  for (;;) {
    if ((await fetchStatus(url)) === 200) return;
    if (now() - start >= timeoutMs) throw new UrlWaitError(`${url} did not answer within ${Math.round(timeoutMs / 1000)} seconds.`);
    await sleep(intervalMs);
  }
}

async function defaultRunSuite(o: CiOptions, budgetUsd?: number, testsDeps?: TestsRunDeps): Promise<TestsRunResult> {
  const { qaReplay, qaRun } = await import('../engine.js');
  const real: TestsRunDeps = testsDeps ?? {
    replay: (script, r) =>
      qaReplay(script, { heal: false, ...(o.headless !== undefined && { headless: o.headless }), ...(r.spendCapUsd && { config: { spendCapUsd: r.spendCapUsd } }) }),
    runCase: (c, r) =>
      qaRun(c.task, r.url, {
        ...(o.headless !== undefined && { headless: o.headless }),
        ...(o.storageState && { storageStatePath: o.storageState }),
        ...(r.spendCapUsd && { config: { spendCapUsd: r.spendCapUsd } }),
      }),
    ...(o.storageState && { storageState: o.storageState }),
  };
  return runTests({ all: true, url: o.url, ...(budgetUsd !== undefined && { budgetUsd }) }, real);
}

/** Run everything requested; never throws for a verdict — only reports it. */
export async function runCi(opts: CiOptions, deps: CiDeps = {}): Promise<CiResult> {
  const base: CiResult = { url: opts.url, verdict: 'uncertain', exitCode: INFRA_ERROR_EXIT_CODE, ...(opts.budgetUsd !== undefined && { budgetUsd: opts.budgetUsd }) };
  if (!opts.suite && !opts.check) return { ...base, error: 'Nothing to run — pass --suite and/or --check.' };

  const wait = opts.waitForUrl ?? opts.url;
  opts.progress?.(`Waiting for ${wait} to answer…`);
  try {
    await waitForUrl(wait, deps, opts.waitMs ?? DEFAULT_WAIT_MS);
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }

  const result: CiResult = { ...base };
  const verdicts: Verdict[] = [];
  // One total cap: the check (if any) gets what the suite left is unknowable
  // without per-run spend, so split it evenly when both run.
  const both = Boolean(opts.suite && opts.check);
  const share = opts.budgetUsd === undefined ? undefined : both ? opts.budgetUsd / 2 : opts.budgetUsd;

  if (opts.suite) {
    opts.progress?.('Running the saved tests…');
    try {
      const r = await (deps.runSuite ? deps.runSuite(opts, share) : defaultRunSuite(opts, share, deps.testsDeps));
      result.suite = r;
      verdicts.push(r.verdict);
    } catch (e) {
      return { ...result, error: e instanceof Error ? e.message : String(e) };
    }
  }
  if (opts.check) {
    opts.progress?.('Checking the site…');
    try {
      const r = await (deps.runCheck
        ? deps.runCheck(opts, share)
        : runSiteCheck(opts.url, {
            ...(opts.maxPages && { maxPages: opts.maxPages }),
            ...(opts.storageState && { storageState: opts.storageState }),
            ...(opts.headless !== undefined && { headless: opts.headless }),
            ...(share !== undefined && { budgetUsd: share }),
            ...(opts.progress && { progress: opts.progress }),
          } satisfies SiteCheckOptions));
      const slim = slimSiteCheck(r);
      result.check = slim;
      // A "problem" finding from the crawl also fails the check, like `spike check`.
      verdicts.push(slim.problems.length && slim.verdict === 'pass' ? 'fail' : slim.verdict);
    } catch (e) {
      if (!(e instanceof SiteCheckError)) throw e;
      return { ...result, error: e.message };
    }
  }
  result.verdict = worstVerdict(verdicts);
  result.exitCode = exitCodeForVerdict(result.verdict);
  return result;
}

const ICON: Record<Verdict, string> = { pass: 'Passed', fail: 'Failed', uncertain: 'Not sure' };

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** The Markdown summary: verdict table, failing steps, pages checked, spend cap. */
export function renderCiSummary(r: CiResult): string {
  const out: string[] = ['## Spike test results', ''];
  if (r.error) {
    out.push(`Spike could not run: ${r.error}`, '', `Address: ${r.url}`);
    return `${out.join('\n')}\n`;
  }
  out.push(`**${ICON[r.verdict]}** on ${r.url}`, '');
  if (r.suite) {
    out.push(`### Saved tests — ${r.suite.summary}`, '');
    if (r.suite.tests.length) {
      out.push('| Test | Result | Why |', '| --- | --- | --- |');
      for (const t of r.suite.tests) out.push(`| ${cell(t.test)} | ${ICON[t.verdict]} | ${cell(t.reason ?? '')} |`);
    } else out.push('No saved tests matched.');
    out.push('');
  }
  if (r.check) {
    out.push(`### Site check — ${ICON[r.check.verdict]}, ${r.check.pagesChecked} page${r.check.pagesChecked === 1 ? '' : 's'} looked at`, '');
    if (r.check.problems.length) {
      out.push('| Page | What is wrong |', '| --- | --- |');
      for (const p of r.check.problems) out.push(`| ${cell(p.page)} | ${cell(p.what)} |`);
    } else out.push(r.check.summary);
    out.push('');
  }
  if (r.budgetUsd !== undefined) out.push(`Spend cap for this run: $${r.budgetUsd.toFixed(2)}.`, '');
  return `${out.join('\n')}\n`;
}

const xmlEsc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] as string);

/** JUnit XML from the aggregate (suite tests + one case per problem page). */
export function renderCiJunit(r: CiResult): string {
  const cases: string[] = [];
  let failures = 0;
  const add = (name: string, verdict: Verdict, why?: string) => {
    if (verdict === 'pass') return void cases.push(`    <testcase name="${xmlEsc(name)}"/>`);
    failures++;
    const tag = verdict === 'fail' ? 'failure' : 'skipped';
    cases.push(`    <testcase name="${xmlEsc(name)}"><${tag} message="${xmlEsc(why ?? verdict)}"/></testcase>`);
  };
  if (r.error) add('spike ci', 'fail', r.error);
  for (const t of r.suite?.tests ?? []) add(t.test, t.verdict, t.reason);
  for (const p of r.check?.problems ?? []) add(`check: ${p.page}`, 'fail', p.what);
  if (r.check && !r.check.problems.length) add('check: site', r.check.verdict);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="spike ci" tests="${cases.length}" failures="${failures}">\n${cases.join('\n')}\n  </testsuite>\n</testsuites>\n`;
}

/** Write the summary (and JUnit, when asked); also append to
 * `$GITHUB_STEP_SUMMARY` when set. */
export function writeCiOutputs(r: CiResult, o: { summary?: string; junit?: string; env?: NodeJS.ProcessEnv }): void {
  const md = renderCiSummary(r);
  const put = (p: string, body: string) => {
    fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
    fs.writeFileSync(p, body);
  };
  if (o.summary) put(o.summary, md);
  if (o.junit) put(o.junit, renderCiJunit(r));
  const gh = (o.env ?? process.env).GITHUB_STEP_SUMMARY;
  if (gh) fs.appendFileSync(gh, md);
}
