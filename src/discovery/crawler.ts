/* Deterministic same-origin BFS crawl — the second, "cheap, no model" layer
 * of A23's discovery ladder. Browser-agnostic by construction: this module
 * never imports engine.ts, driver/loop.ts, or any BrowserPort. A caller
 * injects a `Fetcher` — the same pattern `src/suite/runner.ts` uses for
 * `RunOneFn` — so in production it can be a real browser navigate+read-the-DOM
 * call (`browser-crawl.ts`, the default since A24: it carries the user's
 * sign-in and sees a page that draws itself with JavaScript) or a plain
 * `fetch()` (faster, blind to both); tests inject a fake fetcher over canned
 * HTML with no network at all.
 *
 * Politeness/boundedness (explicit constraint from the task): same-origin
 * only, a depth cap, a total page cap, and a parameterised-URL explosion
 * guard (`/products/1`, `/products/2`, ... collapse onto one route pattern,
 * capped at `maxPerRoutePattern` concrete instances actually fetched). */

import { normalizeUrlForActionCache } from '../cache/action-cache.js';
import { pageSignatureFromAx } from '../cache/action-cache.js';
import { extractInteractiveElements, extractLinks, extractScriptUrls, findDeadLinks, structuralSignatureFromHtml, type InteractiveElement } from './html.js';

/** A request the page made that did not come back cleanly. A24: a bare-`fetch`
 * crawl can only ever see the document's own status code; a crawl driven
 * through a real browser also sees every call the page made after it loaded,
 * which is where a client-rendered app's failures actually live. */
export interface FailedRequest {
  url: string;
  status?: number;
  errorText?: string;
}

export interface Fetched {
  url: string;
  status: number;
  html: string;
  /** Uncaught JavaScript errors the page threw while loading. Only a
   * browser-driven fetcher can populate this; a plain HTTP fetcher leaves it
   * absent, and the findings layer simply has less to judge. */
  pageErrors?: string[];
  /** Same-origin requests the page made that failed or returned 5xx. */
  failedRequests?: FailedRequest[];
}

/** Fetch-or-navigate seam: return `null` for a failed/errored fetch (the
 * crawler treats that URL as a dead end, not a crash). */
export type Fetcher = (url: string) => Promise<Fetched | null>;

export interface CrawlOptions {
  /** How many link-hops from a seed URL to follow. Default 3. */
  maxDepth?: number;
  /** Hard cap on pages actually fetched, regardless of how much more the
   * graph has left to offer. Default 200. */
  maxPages?: number;
  /** Concrete URLs explored per collapsed route pattern (see
   * `collapseParameterizedPath`) before the rest are skipped — the
   * URL-explosion guard. Default 3: enough to sample a parameterised route's
   * structure without crawling every product/order/user page on a large
   * site. */
  maxPerRoutePattern?: number;
  /** Origin same-origin-ness is judged against. Defaults to the first seed
   * URL's origin. */
  allowedOrigin?: string;
}

export interface CrawledPage {
  url: string;
  normalizedUrl: string;
  /** Parameterised-collapsed pathname, e.g. `/products/:param`. */
  routePattern: string;
  depth: number;
  status: number;
  structuralSignature: string;
  /** Coarse content hash (via `pageSignatureFromAx` treating raw HTML as
   * opaque material) — a finer-grained signal than `structuralSignature`,
   * kept for a future A24 Tier-1 differential oracle; not used for state
   * identity/coverage bucketing, which is `structuralSignature`'s job. */
  contentSignature: string;
  interactiveElements: InteractiveElement[];
  /** Same-origin links discovered on this page (post-filter). */
  links: string[];
  /** Uncaught JavaScript errors seen while this page loaded (empty for a
   * plain-HTTP crawl, which cannot observe them). Optional so a caller
   * hand-building a page record — the ledger tests do — stays valid. */
  pageErrors?: string[];
  /** Requests this page made that failed or returned 5xx (same caveat). */
  failedRequests?: FailedRequest[];
  /** Labels of anchors that cannot navigate anywhere — see `findDeadLinks`. */
  deadLinks?: string[];
  /** `<script src>` URLs on this page, for the bundle route extractor. */
  scriptUrls?: string[];
}

export interface CrawlResult {
  pages: CrawledPage[];
  /** Count of distinct normalized URLs the BFS ever dequeued (includes pages
   * skipped for being cross-origin/pattern-capped — NOT just `pages.length`). */
  visitedCount: number;
  /** True when the queue still had unexplored URLs when `maxPages` was hit. */
  cappedByMaxPages: boolean;
  skippedExternal: number;
  skippedByRoutePatternCap: number;
}

/** A path segment that looks like an identifier rather than a stable route
 * name: all-digits, a UUID, or a long hex-ish token. Conservative on purpose
 * — a false negative (treating an id as a static segment) just means the
 * explosion guard undersamples less; a false positive (collapsing a real
 * static segment) would corrupt route identity. */
function looksLikeParam(segment: string): boolean {
  if (/^\d+$/.test(segment)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return true;
  if (/^[a-f0-9]{16,}$/i.test(segment)) return true;
  return false;
}

export function collapseParameterizedPath(pathname: string): string {
  const segs = pathname.split('/').filter(Boolean);
  const collapsed = segs.map((seg) => (looksLikeParam(seg) ? ':param' : seg));
  return collapsed.length ? `/${collapsed.join('/')}` : '/';
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '/';
  }
}

export async function crawlSite(seedUrls: string[], fetcher: Fetcher, opts: CrawlOptions = {}): Promise<CrawlResult> {
  const maxDepth = opts.maxDepth ?? 3;
  const maxPages = opts.maxPages ?? 200;
  const maxPerRoutePattern = opts.maxPerRoutePattern ?? 3;
  const origin = opts.allowedOrigin ?? originOf(seedUrls[0] ?? '');

  const visited = new Set<string>();
  const patternCounts = new Map<string, number>();
  const queue: Array<{ url: string; depth: number }> = seedUrls.map((url) => ({ url, depth: 0 }));
  const pages: CrawledPage[] = [];
  let skippedExternal = 0;
  let skippedByRoutePatternCap = 0;
  let cappedByMaxPages = false;

  while (queue.length > 0) {
    if (pages.length >= maxPages) {
      cappedByMaxPages = true;
      break;
    }
    const { url, depth } = queue.shift()!;
    const normalizedUrl = normalizeUrlForActionCache(url);
    if (visited.has(normalizedUrl)) continue;
    visited.add(normalizedUrl);

    if (originOf(url) !== origin) {
      skippedExternal++;
      continue;
    }

    const routePattern = collapseParameterizedPath(pathnameOf(url));
    const countSoFar = patternCounts.get(routePattern) ?? 0;
    if (countSoFar >= maxPerRoutePattern) {
      skippedByRoutePatternCap++;
      continue;
    }
    patternCounts.set(routePattern, countSoFar + 1);

    const fetched = await fetcher(url);
    if (!fetched) continue;

    const links = extractLinks(fetched.html, url).filter((l) => originOf(l) === origin);
    pages.push({
      url,
      normalizedUrl,
      routePattern,
      depth,
      status: fetched.status,
      structuralSignature: structuralSignatureFromHtml(fetched.html),
      contentSignature: pageSignatureFromAx(fetched.html),
      interactiveElements: extractInteractiveElements(fetched.html),
      links,
      pageErrors: fetched.pageErrors ?? [],
      failedRequests: fetched.failedRequests ?? [],
      deadLinks: findDeadLinks(fetched.html),
      scriptUrls: extractScriptUrls(fetched.html, url),
    });

    if (depth < maxDepth) {
      for (const link of links) {
        if (!visited.has(normalizeUrlForActionCache(link))) queue.push({ url: link, depth: depth + 1 });
      }
    }
  }

  return { pages, visitedCount: visited.size, cappedByMaxPages, skippedExternal, skippedByRoutePatternCap };
}
