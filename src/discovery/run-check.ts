/* The engine behind `spike check` and the MCP `site_check` tool (A4): walk a
 * site, look at each page it found (look-only), roll the results up. Lives here
 * — not in cli.ts — so both front doors run the SAME code. Browser/model work
 * is injected (`buildMap`, `runPage`) so it is testable without Chrome. */

import fs from 'node:fs';
import path from 'node:path';
import {
  browserFetcher,
  checkInstruction,
  checkTargets,
  coverageReport,
  DEFAULT_CHECK_PAGES,
  discoverApp,
  explorationOptions,
  loadAppModel,
  renderCheckSummary,
  saveAppModel,
  type AppModel,
  type AppModelFinding,
  type Fetched,
} from './index.js';
import { createPlanningRouter, injectStorageState, loadStorageStateFile, openBrowserSession, qaRun } from '../engine.js';
import { flowsFromRoutes, runFanOut, type FanOutOutcome, type FlowRunResult } from '../driver/spec-decompose.js';
import type { QaConfig } from '../config.js';

export interface MapCrawlOptions {
  maxDepth?: number;
  maxPages?: number;
  browser: boolean;
  via?: 'cdp' | 'extension' | 'playwright';
  storageState?: string;
  headless?: boolean;
  /** E7: also open pop-ups/tabs/"show more" after the walk (needs real Chrome). */
  explore?: boolean;
}

export const httpFetcher = async (url: string): Promise<Fetched | null> => {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('html')) return { url: res.url || url, status: res.status, html: '' };
    return { url: res.url || url, status: res.status, html: await res.text() };
  } catch {
    return null; // a dead end, not a crash — the crawler moves on
  }
};

/** Reads a static asset (a JavaScript bundle) as text. */
export const httpTextFetcher = async (url: string): Promise<string | null> => {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
};

export function collectAppDirFiles(root: string): { files: string[]; routerKind: 'app' | 'pages' } | undefined {
  for (const [dir, routerKind] of [['app', 'app'], ['src/app', 'app'], ['pages', 'pages'], ['src/pages', 'pages']] as const) {
    const abs = path.resolve(root, dir);
    if (!fs.existsSync(abs)) continue;
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p2 = path.join(d, e.name);
        if (e.isDirectory()) walk(p2);
        else files.push(path.relative(abs, p2));
      }
    };
    walk(abs);
    if (files.length) return { files, routerKind };
  }
  return undefined;
}

/** Build the model for a site, opening (and closing) a browser when the crawl
 * is a browsing one. Shared by `spike map` and `spike check`. */
export async function buildSiteMap(url: string, opts: MapCrawlOptions, progress?: (line: string) => void): Promise<AppModel> {
  const root = process.cwd();
  const previousModel = loadAppModel(root);
  const src = collectAppDirFiles(root);
  const crawl = {
    ...(opts.maxDepth !== undefined && { maxDepth: opts.maxDepth }),
    ...(opts.maxPages !== undefined && { maxPages: opts.maxPages }),
  };
  const common = {
    baseUrl: url,
    ...(src && { appDirFiles: src.files, routerKind: src.routerKind }),
    previousModel,
    crawl,
    bundleFetcher: httpTextFetcher,
  };

  if (!opts.browser) {
    progress?.('Looking at the site over the network (no sign-in, no JavaScript)…');
    return discoverApp({ ...common, fetcher: httpFetcher });
  }

  progress?.('Opening the site in Chrome…');
  const session = await openBrowserSession({
    ...(opts.via && { via: opts.via }),
    ...(opts.headless !== undefined && { headless: opts.headless }),
  });
  try {
    if (opts.storageState) {
      await injectStorageState(session.browser, loadStorageStateFile(opts.storageState));
      progress?.('Signed in using the saved session.');
    }
    progress?.('Walking the site…');
    return await discoverApp({
      ...common,
      fetcher: browserFetcher(session.browser, { sameOrigin: new URL(url).origin }),
      ...explorationOptions({
        enabled: opts.explore === true,
        browser: session.browser,
        planner: createPlanningRouter(),
        allowedOrigin: new URL(url).origin,
        ...(progress && { onProgress: progress }),
      }),
    });
  } finally {
    await session.close().catch(() => {});
  }
}

export class SiteCheckError extends Error {}

export interface SiteCheckOptions {
  maxPages?: number;
  storageState?: string;
  via?: 'cdp' | 'extension' | 'playwright';
  browser?: boolean;
  headless?: boolean;
  explore?: boolean;
  /** Per-page spend cap in USD (passed to each page's run). */
  budgetUsd?: number;
  progress?: (line: string) => void;
}

export interface SiteCheckDeps {
  buildMap?: (url: string, opts: MapCrawlOptions, progress?: (l: string) => void) => Promise<AppModel>;
  /** Looks at ONE page. Default: a look-only qaRun. */
  runPage?: (task: string, address: string, opts: SiteCheckOptions) => Promise<FlowRunResult>;
  saveModel?: (model: AppModel) => void;
}

export interface SiteCheckResult {
  summary: string;
  outcome: FanOutOutcome;
  model: AppModel;
  findings: AppModelFinding[];
  pagesChecked: number;
  problems: number;
  capped: boolean;
}

/** Walk + check. Throws SiteCheckError when the site cannot be walked or has no
 * pages — callers turn that into their own error shape. */
export async function runSiteCheck(url: string, opts: SiteCheckOptions = {}, deps: SiteCheckDeps = {}): Promise<SiteCheckResult> {
  const maxPages = opts.maxPages && opts.maxPages > 0 ? opts.maxPages : DEFAULT_CHECK_PAGES;
  const browser = opts.browser !== false;
  const progress = opts.progress;
  const buildMap = deps.buildMap ?? buildSiteMap;
  const runPage =
    deps.runPage ??
    ((task, address, o): Promise<FlowRunResult> =>
      qaRun(task, address, {
        readOnly: true, // a check nobody asked for must never press anything
        record: false,
        replay: false,
        headless: o.headless,
        storageStatePath: o.storageState,
        config: {
          ...(o.via && { via: o.via }),
          ...(o.budgetUsd && { spendCapUsd: o.budgetUsd }),
        } as Partial<QaConfig>,
      }));

  let model: AppModel;
  try {
    model = await buildMap(
      url,
      {
        maxPages: maxPages * 2,
        browser,
        via: opts.via,
        storageState: opts.storageState,
        headless: opts.headless,
        explore: opts.explore === true && browser,
      },
      progress,
    );
  } catch (e) {
    throw new SiteCheckError(`I could not walk that site: ${e instanceof Error ? e.message : String(e)}`);
  }
  (deps.saveModel ?? ((m: AppModel) => saveAppModel(m, process.cwd())))(model);

  const targets = checkTargets(model, url, maxPages);
  if (!targets.length) throw new SiteCheckError('I could not find any pages to look at on that site.');
  const capped = targets.length < checkTargets(model, url, Number.MAX_SAFE_INTEGER).length;
  progress?.(`Found ${targets.length} page${targets.length === 1 ? '' : 's'}. Looking at each one…`);

  const flows = flowsFromRoutes(
    targets.map((t) => ({ url: t.url, name: t.name })),
    { baseUrl: url, maxFlows: targets.length, instruction: (_r, address) => checkInstruction(address) },
  );
  const outcome = await runFanOut(flows, {
    runFlow: (flow, i) => runPage(flow.task, targets[i]?.url ?? url, opts),
    ...(opts.storageState && { storageStatePath: opts.storageState }),
    onProgress: progress,
  });

  const findings = model.findings ?? [];
  const cov = coverageReport(model);
  const problems = outcome.flows.filter((f) => f.verdict === 'fail').length;
  const summary = renderCheckSummary({
    pagesChecked: outcome.coverage.flowsAttempted,
    controlsFound: cov.interactiveElements.total,
    problems,
    capped,
  });
  return { summary, outcome, model, findings, pagesChecked: outcome.coverage.flowsAttempted, problems, capped };
}

export const MAX_SITE_CHECK_PROBLEMS = 20;

/** The slim, agent-facing shape of a check (A4): capped, one line per problem. */
export function slimSiteCheck(r: SiteCheckResult): {
  verdict: FanOutOutcome['verdict'];
  pagesChecked: number;
  problems: { page: string; what: string }[];
  summary: string;
} {
  const clip = (s: string) => (s.length > 200 ? `${s.slice(0, 199)}…` : s);
  const problems: { page: string; what: string }[] = [];
  for (const f of r.outcome.flows) if (f.verdict === 'fail') problems.push({ page: f.name, what: clip(f.reason || 'looked broken') });
  for (const f of r.findings) if (f.severity === 'problem') problems.push({ page: f.route, what: clip(f.detail) });
  return {
    verdict: r.outcome.verdict,
    pagesChecked: r.pagesChecked,
    problems: problems.slice(0, MAX_SITE_CHECK_PROBLEMS),
    summary: r.summary,
  };
}
