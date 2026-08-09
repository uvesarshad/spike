/* v47 — A23 (P0) + A25 (P1): the autonomy axis — app model, discovery,
 * coverage ledger, and change-triggered re-exploration diffing.
 *
 * Standalone tsx test, no framework (this repo runs suites directly with
 * tsx + a custom check()/process.exit — see docs/infra/testing.md and
 * test/v44.suite.ts, the reference for this file's shape).
 *
 * NO browser, NO network anywhere in this file: `src/discovery/crawler.ts`'s
 * `Fetcher` is injected and every test here supplies a fake one backed by an
 * in-memory URL->HTML map; `src/discovery/static-routes.ts`'s file-list
 * extraction is a pure function over a canned string array, never real fs.
 *
 * Covers (per the task):
 *   1. structural signature collapses data-only variation (10 vs 11 items)
 *      but distinguishes a modal being open
 *   2. BFS respects depth cap, max-page cap, and same-origin
 *   3. parameterised URL explosion is collapsed (route-pattern cap)
 *   4. static route extraction: sitemap.xml text + a fake app/ dir listing
 *      (both App Router and Pages Router)
 *   5. coverage math (exercised/discovered), including zero-discovered
 *   6. diffAppModel: new/changed/removed buckets + priority order
 *   7. AppModel round-trips through save/load
 *   8. discoverApp end-to-end over a small fake site (bonus integration
 *      check tying the layers together)
 *
 * Run: npx tsx test/v47.discovery.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { structuralSignatureFromHtml } from '../src/discovery/html.js';
import { collapseParameterizedPath, crawlSite, type Fetched, type Fetcher } from '../src/discovery/crawler.js';
import { parseSitemapXml, routesFromFileList } from '../src/discovery/static-routes.js';
import { coverageReport } from '../src/discovery/coverage.js';
import { diffAppModel } from '../src/discovery/diff.js';
import {
  emptyAppModel,
  saveAppModel,
  loadAppModel,
  appModelPath,
  markRouteExercised,
  markElementTouched,
  upsertCrawledPage,
  type AppModel,
  type AppModelRoute,
} from '../src/discovery/app-model.js';
import { discoverApp } from '../src/discovery/discover.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

function freshRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v47-discovery-'));
}

/** Builds a `Fetcher` over an in-memory URL->HTML map, plus a request log so
 * tests can assert on WHICH urls were actually fetched (not just what the
 * final page set contains). Missing urls resolve to `null` (a dead
 * link/fetch failure), matching `Fetcher`'s documented contract. */
function fakeFetcher(pages: Record<string, { status?: number; html: string }>): { fetcher: Fetcher; log: string[] } {
  const log: string[] = [];
  const fetcher: Fetcher = async (url: string): Promise<Fetched | null> => {
    log.push(url);
    const page = pages[url];
    if (!page) return null;
    return { url, status: page.status ?? 200, html: page.html };
  };
  return { fetcher, log };
}

/* ===================== 1/8: structural signature ===================== */
console.log('=== v47 1/8: structural signature collapses data variation, distinguishes a modal ===');
{
  const productList = (n: number) =>
    `<html><body><nav><a href="/">Home</a></nav><main><h1>Products</h1><ul>${Array.from(
      { length: n },
      (_, i) => `<li><a href="/products/${i + 1}">Product ${i + 1} - $${(i + 1) * 10}</a></li>`,
    ).join('')}</ul></main></body></html>`;

  const sig10 = structuralSignatureFromHtml(productList(10));
  const sig11 = structuralSignatureFromHtml(productList(11));
  check('10 vs 11 list items produce the IDENTICAL structural signature', sig10 === sig11);

  const sig10Again = structuralSignatureFromHtml(productList(10));
  check('structural signature is deterministic across repeated calls', sig10 === sig10Again);

  const withModal = `${productList(10).replace('</body>', '<div role="dialog"><h2>Confirm delete</h2><button>Yes</button><button>No</button></div></body>')}`;
  const sigModal = structuralSignatureFromHtml(withModal);
  check('opening a modal (new dialog subtree) produces a DIFFERENT structural signature', sigModal !== sig10);

  // Pure data variation inside an existing element (price text differs, item
  // count identical) must still collapse — this isolates "value changed" from
  // "cardinality changed" as two different no-ops for the structural sig.
  const priceVariant = productList(10).replace('$10', '$999');
  check('changing text content alone (same element count) does not change the structural signature', structuralSignatureFromHtml(priceVariant) === sig10);

  // A structurally different page (an entirely different landmark set) must
  // differ — sanity check that the signature isn't degenerate/constant.
  const differentPage = '<html><body><form><input type="text" name="q"/><button>Search</button></form></body></html>';
  check('an unrelated page shape produces a different signature (not a constant hash)', structuralSignatureFromHtml(differentPage) !== sig10);
}

/* ===================== 2/8: BFS depth/max-page/same-origin ===================== */
console.log('\n=== v47 2/8: BFS respects depth cap, max-page cap, and same-origin ===');
{
  const base = 'https://site.test';
  const page = (links: string[]) => `<html><body>${links.map((l) => `<a href="${l}">link</a>`).join('')}</body></html>`;

  // depth cap
  {
    const { fetcher, log } = fakeFetcher({
      [`${base}/`]: { html: page([`${base}/a`]) },
      [`${base}/a`]: { html: page([`${base}/b`]) },
      [`${base}/b`]: { html: page([`${base}/c`]) },
      [`${base}/c`]: { html: page([`${base}/d`]) },
      [`${base}/d`]: { html: page([]) },
    });
    const result = await crawlSite([`${base}/`], fetcher, { maxDepth: 2, maxPages: 50 });
    const urls = result.pages.map((p) => p.url).sort();
    check('depth cap: pages at depth 0/1/2 are fetched', urls.includes(`${base}/`) && urls.includes(`${base}/a`) && urls.includes(`${base}/b`));
    check('depth cap: pages beyond the cap are never fetched', !urls.includes(`${base}/c`) && !urls.includes(`${base}/d`) && !log.includes(`${base}/c`));
    check('depth is recorded correctly per page', result.pages.find((p) => p.url === `${base}/`)?.depth === 0 && result.pages.find((p) => p.url === `${base}/b`)?.depth === 2);
  }

  // same-origin: a link discovered ON a page must never be enqueued/fetched
  {
    const { fetcher, log } = fakeFetcher({
      [`${base}/`]: { html: page([`${base}/a`, 'https://external.test/ext']) },
      [`${base}/a`]: { html: page([]) },
      'https://external.test/ext': { html: page([]) },
    });
    const result = await crawlSite([`${base}/`], fetcher, { maxDepth: 3, maxPages: 50 });
    check('a same-origin link discovered on a page IS fetched', result.pages.some((p) => p.url === `${base}/a`));
    check('a cross-origin link discovered on a page is NEVER fetched', !log.includes('https://external.test/ext'));
    check('cross-origin links never appear in any crawled page.links', result.pages.every((p) => p.links.every((l) => l.startsWith(base))));
  }

  // same-origin: a cross-origin SEED is skipped and counted
  {
    const { fetcher } = fakeFetcher({ [`${base}/`]: { html: page([]) } });
    const result = await crawlSite([`${base}/`, 'https://external.test/seed'], fetcher, {});
    check('a cross-origin seed URL is counted in skippedExternal', result.skippedExternal === 1);
    check('a cross-origin seed URL never produces a crawled page', !result.pages.some((p) => p.url.includes('external.test')));
  }

  // max-page cap
  {
    const hubLinks = Array.from({ length: 9 }, (_, i) => `${base}/hub-${i}`);
    const sitePages: Record<string, { html: string }> = { [`${base}/`]: { html: page(hubLinks) } };
    for (const l of hubLinks) sitePages[l] = { html: page([]) };
    const { fetcher } = fakeFetcher(sitePages);
    const result = await crawlSite([`${base}/`], fetcher, { maxDepth: 3, maxPages: 5 });
    check('max-page cap: exactly maxPages pages are fetched', result.pages.length === 5);
    check('max-page cap: cappedByMaxPages is reported true when the queue still had work', result.cappedByMaxPages === true);
  }

  // no cap hit -> cappedByMaxPages is false
  {
    const { fetcher } = fakeFetcher({ [`${base}/`]: { html: page([]) } });
    const result = await crawlSite([`${base}/`], fetcher, { maxDepth: 3, maxPages: 50 });
    check('cappedByMaxPages is false when the crawl exhausts the graph before the cap', result.cappedByMaxPages === false);
  }
}

/* ===================== 3/8: parameterised URL explosion ===================== */
console.log('\n=== v47 3/8: parameterised URL explosion is collapsed ===');
{
  check('collapseParameterizedPath collapses a numeric id', collapseParameterizedPath('/products/42') === '/products/:param');
  check('collapseParameterizedPath collapses a UUID', collapseParameterizedPath('/orders/550e8400-e29b-41d4-a716-446655440000') === '/orders/:param');
  check('collapseParameterizedPath leaves a static segment alone', collapseParameterizedPath('/about') === '/about');
  check('collapseParameterizedPath handles the root', collapseParameterizedPath('/') === '/');
  check('collapseParameterizedPath collapses only the parameterised segment, keeping siblings', collapseParameterizedPath('/products/42/reviews') === '/products/:param/reviews');

  const base = 'https://shop.test';
  const page = (links: string[]) => `<html><body>${links.map((l) => `<a href="${l}">p</a>`).join('')}</body></html>`;
  const productIds = Array.from({ length: 12 }, (_, i) => i + 1);
  const sitePages: Record<string, { html: string }> = {
    [`${base}/`]: { html: page(productIds.map((id) => `${base}/products/${id}`)) },
  };
  for (const id of productIds) sitePages[`${base}/products/${id}`] = { html: page([]) };
  const { fetcher } = fakeFetcher(sitePages);

  const result = await crawlSite([`${base}/`], fetcher, { maxDepth: 2, maxPages: 50, maxPerRoutePattern: 3 });
  const productPages = result.pages.filter((p) => p.routePattern === '/products/:param');
  check('at most maxPerRoutePattern concrete instances of a parameterised route are fetched', productPages.length === 3);
  check('the rest are counted as skipped by the route-pattern cap', result.skippedByRoutePatternCap === productIds.length - 3);
  check('the hub page itself is still fetched (not subject to the products cap)', result.pages.some((p) => p.url === `${base}/`));
}

/* ===================== 4/8: static route extraction ===================== */
console.log('\n=== v47 4/8: static route extraction (sitemap.xml text + fake app/pages dir listing) ===');
{
  const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://shop.test/</loc></url>
  <url><loc>https://shop.test/about</loc></url>
  <url><loc>https://shop.test/products?ref=nav&amp;utm_source=x</loc></url>
</urlset>`;
  const locs = parseSitemapXml(sitemapXml);
  check('parseSitemapXml extracts every <loc>', locs.length === 3);
  check('parseSitemapXml preserves the URL text (entity-decoded)', locs.includes('https://shop.test/products?ref=nav&utm_source=x'));
  check('parseSitemapXml returns an empty array for a sitemap with no <loc>', parseSitemapXml('<urlset></urlset>').length === 0);

  // App Router (app/) fake directory listing.
  const appFiles = [
    'app/page.tsx',
    'app/about/page.tsx',
    'app/(marketing)/contact/page.tsx', // route group — must NOT appear as a segment
    'app/products/[id]/page.tsx', // dynamic segment
    'app/products/[id]/layout.tsx', // not a page file — must be ignored
    'app/blog/[...slug]/page.tsx', // catch-all
    'app/dashboard/loading.tsx', // not a page file — ignored
  ];
  const appRoutes = routesFromFileList(appFiles, 'app');
  check('app router: root page.tsx -> "/"', appRoutes.includes('/'));
  check('app router: static segment -> "/about"', appRoutes.includes('/about'));
  check('app router: route group folder is dropped from the path', appRoutes.includes('/contact') && !appRoutes.some((r) => r.includes('marketing')));
  check('app router: dynamic segment -> "/products/:id"', appRoutes.includes('/products/:id'));
  check('app router: catch-all -> "/blog/*"', appRoutes.includes('/blog/*'));
  check('app router: non-page files (layout/loading) produce no route', appRoutes.length === 5);

  // Pages Router (pages/) fake directory listing.
  const pagesFiles = [
    'pages/index.tsx',
    'pages/about.tsx',
    'pages/blog/index.tsx',
    'pages/blog/[id].tsx',
    'pages/api/hello.ts', // API route — not UI surface
    'pages/_app.tsx', // framework file — ignored
    'pages/_document.tsx', // framework file — ignored
  ];
  const pagesRoutes = routesFromFileList(pagesFiles, 'pages');
  check('pages router: index.tsx -> "/"', pagesRoutes.includes('/'));
  check('pages router: about.tsx -> "/about"', pagesRoutes.includes('/about'));
  check('pages router: blog/index.tsx -> "/blog"', pagesRoutes.includes('/blog'));
  check('pages router: blog/[id].tsx -> "/blog/:id"', pagesRoutes.includes('/blog/:id'));
  check('pages router: api/ routes are excluded', !pagesRoutes.some((r) => r.includes('hello')));
  check('pages router: _app/_document produce no route', pagesRoutes.length === 4);

  check('routesFromFileList output is sorted and deduplicated', JSON.stringify(appRoutes) === JSON.stringify([...new Set(appRoutes)].sort()));
}

/* ===================== 5/8: coverage math ===================== */
console.log('\n=== v47 5/8: coverage math (exercised/discovered), including zero-discovered ===');
{
  const zero = coverageReport(emptyAppModel('https://shop.test'));
  check('zero-discovered routes: total is 0', zero.routes.total === 0);
  check('zero-discovered routes: ratio is 0, not NaN', zero.routes.ratio === 0 && !Number.isNaN(zero.routes.ratio));
  check('zero-discovered elements: ratio is 0, not NaN', zero.interactiveElements.ratio === 0 && !Number.isNaN(zero.interactiveElements.ratio));
  check('zero-discovered: perRoute is empty', zero.perRoute.length === 0);

  const model = emptyAppModel('https://shop.test');
  const now = new Date().toISOString();
  upsertCrawledPage(model, {
    url: 'https://shop.test/',
    normalizedUrl: 'https://shop.test/',
    routePattern: '/',
    depth: 0,
    status: 200,
    structuralSignature: 'sig-home',
    contentSignature: 'content-home',
    interactiveElements: [{ role: 'link', name: 'About' }, { role: 'button', name: 'Search' }],
    links: [],
  }, now);
  upsertCrawledPage(model, {
    url: 'https://shop.test/about',
    normalizedUrl: 'https://shop.test/about',
    routePattern: '/about',
    depth: 1,
    status: 200,
    structuralSignature: 'sig-about',
    contentSignature: 'content-about',
    interactiveElements: [{ role: 'link', name: 'Home' }],
    links: [],
  }, now);
  markRouteExercised(model, 'https://shop.test/', 'login.json', now);
  markElementTouched(model, 'https://shop.test/', 'sig-home', { role: 'link', name: 'About' }, 'login.json', now);

  const report = coverageReport(model);
  check('routes.total counts every discovered route', report.routes.total === 2);
  check('routes.exercised counts only routes a script actually ran against', report.routes.exercised === 1);
  check('routes.ratio === exercised/total', report.routes.ratio === 0.5);
  check('interactiveElements.total counts every discovered element across all routes', report.interactiveElements.total === 3);
  check('interactiveElements.touched counts only touched elements', report.interactiveElements.touched === 1);
  check('interactiveElements.ratio === touched/total', Math.abs(report.interactiveElements.ratio - 1 / 3) < 1e-9);
  const homeDetail = report.perRoute.find((r) => r.route === 'https://shop.test/');
  check('perRoute reports which scripts covered a route', JSON.stringify(homeDetail?.coveredByScripts) === JSON.stringify(['login.json']));
  check('perRoute reports per-route element touch counts', homeDetail?.elementsTotal === 2 && homeDetail?.elementsTouched === 1);
}

/* ===================== 6/8: diffAppModel buckets + priority ===================== */
console.log('\n=== v47 6/8: diffAppModel new/changed/removed buckets and priority order ===');
{
  function routeFixture(overrides: Partial<AppModelRoute>): AppModelRoute {
    return {
      route: 'https://shop.test/x',
      source: 'crawl',
      discoveredAt: '2026-01-01T00:00:00.000Z',
      exercised: false,
      states: [{ structuralSignature: 'sig-1', firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z', elements: [] }],
      coveredByScripts: [],
      ...overrides,
    };
  }

  const previous: AppModel = {
    ...emptyAppModel('https://shop.test'),
    routes: [
      routeFixture({ route: 'https://shop.test/unchanged', states: [{ structuralSignature: 'sig-u', firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z', elements: [] }] }),
      routeFixture({
        route: 'https://shop.test/changed-covered',
        exercised: true,
        coveredByScripts: ['checkout.json'],
        states: [{ structuralSignature: 'sig-old', firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z', elements: [] }],
      }),
      routeFixture({
        route: 'https://shop.test/changed-uncovered',
        states: [{ structuralSignature: 'sig-old-2', firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z', elements: [] }],
      }),
      routeFixture({ route: 'https://shop.test/removed' }),
    ],
  };

  const current: AppModel = {
    ...emptyAppModel('https://shop.test'),
    routes: [
      routeFixture({ route: 'https://shop.test/unchanged', states: [{ structuralSignature: 'sig-u', firstSeenAt: '2026-02-01T00:00:00.000Z', lastSeenAt: '2026-02-01T00:00:00.000Z', elements: [] }] }),
      routeFixture({
        route: 'https://shop.test/changed-covered',
        exercised: true,
        coveredByScripts: ['checkout.json'],
        states: [{ structuralSignature: 'sig-new', firstSeenAt: '2026-02-01T00:00:00.000Z', lastSeenAt: '2026-02-01T00:00:00.000Z', elements: [] }],
      }),
      routeFixture({
        route: 'https://shop.test/changed-uncovered',
        states: [{ structuralSignature: 'sig-new-2', firstSeenAt: '2026-02-01T00:00:00.000Z', lastSeenAt: '2026-02-01T00:00:00.000Z', elements: [] }],
      }),
      routeFixture({ route: 'https://shop.test/new-route' }),
    ],
  };

  const diff = diffAppModel(previous, current);
  check('exactly one new route is found', diff.newRoutes.length === 1 && diff.newRoutes[0].route === 'https://shop.test/new-route');
  check('exactly two changed routes are found', diff.changedRoutes.length === 2);
  check('a changed route with prior coverage is flagged hasCoverage=true', diff.changedRoutes.find((c) => c.route === 'https://shop.test/changed-covered')?.hasCoverage === true);
  check('a changed route with no prior coverage is flagged hasCoverage=false', diff.changedRoutes.find((c) => c.route === 'https://shop.test/changed-uncovered')?.hasCoverage === false);
  check('exactly one removed route is found', diff.removedRoutes.length === 1 && diff.removedRoutes[0].route === 'https://shop.test/removed');
  check('the unchanged route is neither new, changed, nor removed', diff.unchangedRoutes.includes('https://shop.test/unchanged'));
  check(
    'unchanged route does not appear in any actionable bucket',
    !diff.newRoutes.some((e) => e.route.includes('unchanged')) &&
      !diff.changedRoutes.some((e) => e.route.includes('unchanged')) &&
      !diff.removedRoutes.some((e) => e.route.includes('unchanged')),
  );

  const order = diff.prioritized.map((e) => e.route);
  check(
    'priority order: new surface > changed-with-coverage > changed-without-coverage > removed',
    JSON.stringify(order) ===
      JSON.stringify(['https://shop.test/new-route', 'https://shop.test/changed-covered', 'https://shop.test/changed-uncovered', 'https://shop.test/removed']),
  );
  check('prioritized entries carry their kind', diff.prioritized[0].kind === 'new-route' && diff.prioritized[3].kind === 'removed-route');

  // Identical models -> everything unchanged, nothing actionable.
  const noopDiff = diffAppModel(previous, previous);
  check('diffing a model against itself yields no new/changed/removed', noopDiff.newRoutes.length === 0 && noopDiff.changedRoutes.length === 0 && noopDiff.removedRoutes.length === 0);
  check('diffing a model against itself: every route is unchanged', noopDiff.unchangedRoutes.length === previous.routes.length);
}

/* ===================== 7/8: AppModel round-trips through save/load ===================== */
console.log('\n=== v47 7/8: AppModel round-trips through save/load ===');
{
  const root = freshRoot();
  check('loadAppModel returns null when no ledger exists yet', loadAppModel(root) === null);

  const model = emptyAppModel('https://shop.test');
  const now = new Date().toISOString();
  upsertCrawledPage(model, {
    url: 'https://shop.test/',
    normalizedUrl: 'https://shop.test/',
    routePattern: '/',
    depth: 0,
    status: 200,
    structuralSignature: 'sig-home',
    contentSignature: 'content-home',
    interactiveElements: [{ role: 'button', name: 'Buy now' }],
    links: ['https://shop.test/cart'],
  }, now);
  markRouteExercised(model, 'https://shop.test/', 'smoke.json', now);

  saveAppModel(model, root);
  check('the ledger file is written at .spike/app-model.json', fs.existsSync(appModelPath(root)));

  const loaded = loadAppModel(root);
  check('loadAppModel returns a model after save', loaded !== null);
  check('round-tripped model is byte-for-byte equal (JSON)', JSON.stringify(loaded) === JSON.stringify(model));
  check('round-tripped route coverage survives', loaded?.routes[0]?.coveredByScripts.includes('smoke.json') === true);

  // Never throws on a corrupt file.
  fs.writeFileSync(appModelPath(root), '{not valid json');
  check('loadAppModel returns null (never throws) on a corrupt ledger file', loadAppModel(root) === null);

  // Never throws when the .spike directory doesn't exist at all.
  const emptyRoot = freshRoot();
  check('loadAppModel returns null in a directory with no .spike/ at all', loadAppModel(emptyRoot) === null);

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(emptyRoot, { recursive: true, force: true });
}

/* ===================== 8/8: discoverApp end-to-end (bonus integration) ===================== */
console.log('\n=== v47 8/8: discoverApp ties static extraction + crawl + ledger together ===');
{
  const base = 'https://shop.test';
  const homeHtml = `<html><body><nav><a href="${base}/about">About</a><a href="${base}/products/1">Product 1</a></nav><button>Open cart</button></body></html>`;
  const aboutHtml = `<html><body><a href="${base}/">Home</a><p>About us</p></body></html>`;
  const productHtml = `<html><body><a href="${base}/">Home</a><h1>Product 1</h1></body></html>`;
  const sitemapXml = `<urlset><url><loc>${base}/</loc></url><url><loc>${base}/about</loc></url></urlset>`;

  const { fetcher, log } = fakeFetcher({
    [`${base}/`]: { html: homeHtml },
    [`${base}/about`]: { html: aboutHtml },
    [`${base}/products/1`]: { html: productHtml },
    [`${base}/sitemap.xml`]: { html: sitemapXml },
    [`${base}/robots.txt`]: { status: 404, html: '' },
  });

  const candidateCalls: unknown[] = [];
  const model = await discoverApp({
    baseUrl: `${base}/`,
    fetcher,
    appDirFiles: ['app/page.tsx', 'app/about/page.tsx', 'app/checkout/page.tsx'],
    routerKind: 'app',
    crawl: { maxDepth: 2, maxPages: 20 },
    exploreInteractionGated: async (candidates) => {
      candidateCalls.push(candidates);
    },
  });

  check('discoverApp fetches sitemap.xml via the injected fetcher', log.includes(`${base}/sitemap.xml`));
  check('discoverApp crawls the home page and its same-origin links', model.routes.some((r) => r.route === `${base}/`) && model.routes.some((r) => r.route === `${base}/about`));
  check('discoverApp records a crawl-sourced route with source "crawl"', model.routes.find((r) => r.route === `${base}/`)?.source === 'crawl');
  check(
    'a statically-declared route the crawl never reaches (checkout) is still recorded, source "static"',
    model.routes.find((r) => r.route === '/checkout')?.source === 'static',
  );
  check('the interaction-gated seam is invoked with the button candidate found on the home page', candidateCalls.length === 1 && (candidateCalls[0] as { role: string }[]).some((c) => c.role === 'button'));

  // Re-running discovery with the previous model as input preserves coverage
  // history (A25's prerequisite: the ledger must not reset on every run).
  markRouteExercised(model, `${base}/`, 'smoke.json');
  const model2 = await discoverApp({ baseUrl: `${base}/`, fetcher, crawl: { maxDepth: 2, maxPages: 20 }, previousModel: model });
  check('re-discovery with previousModel preserves prior exercised/coverage state', model2.routes.find((r) => r.route === `${base}/`)?.coveredByScripts.includes('smoke.json') === true);
}

/* ===================== summary ===================== */
const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v47 discovery checks passed`);
process.exit(failed.length ? 1 : 0);
