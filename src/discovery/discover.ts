/* discoverApp — orchestrates A23's discovery ladder cheapest-first, per the
 * options doc's recommendation: "static seeds -> crawl expands -> AI only
 * for what the crawl provably cannot reach... under a step budget."
 *
 * Layers 1 (static route extraction) and 2 (deterministic crawl) are
 * implemented here and spend nothing. Layer 3 — the exploration pass over
 * state that only exists after a click (pop-ups, tabs, expanders, wizard
 * steps), which link-following can never reach — is the one layer that costs
 * model calls, so this module still does not perform it itself: it identifies
 * the candidates and hands them to `opts.exploreInteractionGated`, then folds
 * whatever that returns into the same ledger. E7 supplies the implementation
 * of that hook (`explore.ts`'s `makeInteractionExplorer`, budget-capped); a
 * caller with no budget for it leaves the hook off and the ladder stops after
 * layer 2, exactly as before. */

import { normalizeUrlForActionCache } from '../cache/action-cache.js';
import { type AppModel, emptyAppModel, findingsForPage, upsertCrawledPage, upsertExploredState, upsertStaticRoute } from './app-model.js';
import { crawlSite, type CrawledPage, type CrawlOptions, type Fetcher } from './crawler.js';
import type { ExplorationResult, InteractionGatedCandidate } from './explore.js';
import { parseRobotsTxt, parseSitemapXml, routesFromBundle, routesFromFileList, type RouterKind } from './static-routes.js';

/** How many JavaScript bundles to read for declared routes. A page pulls in a
 * handful of scripts; reading every one on every crawled page would download
 * the same megabyte repeatedly for nothing. */
const MAX_BUNDLES_READ = 12;

export type { ExplorationResult, InteractionGatedCandidate } from './explore.js';

export interface DiscoverAppOptions {
  /** Seed URL — also fixes the crawl's same-origin boundary. */
  baseUrl: string;
  /** Fetch-or-navigate function, injected — used for the crawl AND for
   * fetching `sitemap.xml`/`robots.txt`. See `crawler.ts`'s `Fetcher`. */
  fetcher: Fetcher;
  /** A Next.js `app/`/`pages/` file listing, already collected by the
   * caller (real filesystem walk in production — the daemon has fs access —
   * a canned array in tests). Absent entirely when unavailable (lite mode,
   * a deployed site with no source access). */
  appDirFiles?: string[];
  routerKind?: RouterKind;
  crawl?: CrawlOptions;
  /** A24: reads a JavaScript bundle as text, so the route table a
   * client-rendered app declares in its own code can be extracted (see
   * `routesFromBundle`). Kept SEPARATE from `fetcher`, which returns markup
   * and may be a live browser navigation — asking a browser to navigate to a
   * .js file would be both wrong and destructive to the crawl. Absent → no
   * bundle extraction, and the other three route sources stand alone. */
  bundleFetcher?: (url: string) => Promise<string | null>;
  /** A previously persisted ledger (`loadAppModel()`) to carry coverage
   * history forward. Omitted/`null` starts a fresh ledger. Never mutated —
   * `discoverApp` returns a new object. */
  previousModel?: AppModel | null;
  /** Layer-3 seam (see file header): given the controls the crawl could not
   * follow, open what can be opened and report back what appeared. Anything
   * returned is folded into the model; returning nothing (the old contract)
   * is still valid and simply adds nothing. `explore.ts` builds the
   * budget-capped implementation. */
  exploreInteractionGated?: (candidates: InteractionGatedCandidate[]) => Promise<ExplorationResult | void>;
}

function normalizeRoutePatternForComparison(pattern: string): string {
  return pattern.replace(/:[^/]+/g, ':param').replace(/\*/g, ':param');
}

async function fetchStaticSeeds(baseUrl: string, fetcher: Fetcher): Promise<string[]> {
  const origin = new URL(baseUrl).origin;
  const urls = new Set<string>();

  const sitemap = await fetcher(`${origin}/sitemap.xml`).catch(() => null);
  if (sitemap && sitemap.status < 400) {
    for (const loc of parseSitemapXml(sitemap.html)) urls.add(loc);
  }

  const robots = await fetcher(`${origin}/robots.txt`).catch(() => null);
  if (robots && robots.status < 400) {
    const { sitemapUrls } = parseRobotsTxt(robots.html);
    for (const sitemapUrl of sitemapUrls) {
      if (sitemapUrl === `${origin}/sitemap.xml`) continue; // already fetched above
      const extra = await fetcher(sitemapUrl).catch(() => null);
      if (extra && extra.status < 400) {
        for (const loc of parseSitemapXml(extra.html)) urls.add(loc);
      }
    }
  }

  return [...urls];
}

/** Buttons are the clearest crawl-blind spot: a `<button>` rarely carries a
 * navigable `href`, so link-following can never tell whether it opens a
 * modal, submits a form, or does nothing observable — exactly the
 * "interaction-gated state" layer 3 is for. */
function findInteractionGatedCandidates(page: CrawledPage): InteractionGatedCandidate[] {
  return page.interactiveElements
    .filter((el) => el.role === 'button')
    .map((el) => ({
      route: page.normalizedUrl,
      role: el.role,
      ...(el.name && { name: el.name }),
      reason: 'button-like control with no discoverable navigation target — candidate for AI exploration',
    }));
}

export async function discoverApp(opts: DiscoverAppOptions): Promise<AppModel> {
  const now = new Date().toISOString();
  const origin = new URL(opts.baseUrl).origin;

  const staticAbsoluteUrls = await fetchStaticSeeds(opts.baseUrl, opts.fetcher);

  const staticPatterns = opts.appDirFiles ? routesFromFileList(opts.appDirFiles, opts.routerKind ?? 'app') : [];
  const staticPatternSeeds = staticPatterns.filter((p) => !p.includes(':') && !p.includes('*')).map((p) => new URL(p, origin).toString());

  const seeds = [...new Set([opts.baseUrl, ...staticAbsoluteUrls, ...staticPatternSeeds])];
  const crawl = await crawlSite(seeds, opts.fetcher, opts.crawl);

  const model: AppModel = opts.previousModel ? (JSON.parse(JSON.stringify(opts.previousModel)) as AppModel) : emptyAppModel(opts.baseUrl);
  model.generatedAt = now;
  if (opts.baseUrl && !model.baseUrl) model.baseUrl = opts.baseUrl;

  for (const page of crawl.pages) upsertCrawledPage(model, page, now);

  const reachedPatterns = new Set(crawl.pages.map((p) => normalizeRoutePatternForComparison(p.routePattern)));
  for (const url of staticAbsoluteUrls) {
    const normalized = normalizeUrlForActionCache(url);
    if (!crawl.pages.some((p) => p.normalizedUrl === normalized)) upsertStaticRoute(model, normalized, now);
  }
  for (const pattern of staticPatterns) {
    if (!reachedPatterns.has(normalizeRoutePatternForComparison(pattern))) upsertStaticRoute(model, pattern, now);
  }

  // A24: the fourth route source — the app's own JavaScript. Runs alongside
  // the Next.js file-list parser above, not instead of it; both feed the same
  // "declared but not reached" static-route path.
  for (const pattern of await bundleRoutes(crawl.pages, origin, opts.bundleFetcher)) {
    if (!reachedPatterns.has(normalizeRoutePatternForComparison(pattern))) upsertStaticRoute(model, pattern, now);
  }

  // A24: judgement. Replaced wholesale rather than appended — see the
  // `findings` field's own note on why a stale finding must not survive.
  model.findings = crawl.pages.flatMap((p) => findingsForPage(p, now));

  // Layer 3. Runs LAST, on purpose: everything the crawl could reach for free
  // is already in the model, so the pass only ever spends its budget on what
  // is genuinely left over — and whatever it opens lands in the same ledger
  // as the rest, indistinguishable to coverage and the report.
  const candidates = crawl.pages.flatMap(findInteractionGatedCandidates);
  if (candidates.length > 0) {
    const explored = await opts.exploreInteractionGated?.(candidates);
    for (const state of explored?.states ?? []) upsertExploredState(model, state, now);
  }

  return model;
}

/** Same-origin script URLs across the crawled pages, deduplicated and capped,
 * read as text and scanned for declared route paths. A bundle that cannot be
 * read is skipped silently: this is an opportunistic extra source, never a
 * reason to fail a map. */
async function bundleRoutes(pages: CrawledPage[], origin: string, fetchBundle: DiscoverAppOptions['bundleFetcher']): Promise<string[]> {
  if (!fetchBundle) return [];
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    for (const src of page.scriptUrls ?? []) {
      if (seen.has(src)) continue;
      seen.add(src);
      try {
        if (new URL(src).origin !== origin) continue;
      } catch {
        continue;
      }
      urls.push(src);
      if (urls.length >= MAX_BUNDLES_READ) break;
    }
    if (urls.length >= MAX_BUNDLES_READ) break;
  }

  const routes = new Set<string>();
  for (const src of urls) {
    const js = await fetchBundle(src).catch(() => null);
    if (!js) continue;
    for (const r of routesFromBundle(js)) routes.add(r);
  }
  return [...routes];
}
