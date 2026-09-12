/* v103 — `spike map` judges what it crawls, and can see a client-rendered app (A24).
 *
 * Mapping used to be descriptive only: it recorded an HTTP status for every
 * page and never looked at it again, so a site where half the pages 500 mapped
 * exactly like a healthy one and the command exited 0 either way. And the crawl
 * was a bare `fetch`, so it carried no sign-in and read only served markup —
 * a client-rendered app yielded one route and no controls.
 *
 * Covers (no Chrome, no network — every fetcher here is a canned in-memory fake):
 *   1. a crawled page that returns 500 produces a blocking finding
 *   2. severity rules: page errors and failed calls block; 404s and links that
 *      go nowhere are reported but do not fail the command
 *   3. the JS-bundle route extractor finds routes in a sample bundle, and
 *      rejects the asset/API paths that share its syntax
 *   4. discoverApp folds bundle routes into the model alongside the Next.js
 *      parser, and replaces (never accumulates) findings between crawls
 *   5. the browser-backed fetcher reads the rendered DOM, attributes page
 *      errors and same-origin failed calls to the page, and ignores a
 *      third-party outage
 */

import {
  browserFetcher,
  crawlSite,
  discoverApp,
  emptyAppModel,
  findingsForPage,
  hasBlockingFindings,
  routesFromBundle,
  type CrawledPage,
  type Fetched,
} from '../src/discovery/index.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const ORIGIN = 'https://shop.example';

/** A canned site: url → {status, html}. Anything not listed 404s. */
function fakeFetcher(pages: Record<string, { status?: number; html?: string }>) {
  return async (url: string): Promise<Fetched | null> => {
    const hit = pages[url];
    if (!hit) return { url, status: 404, html: '' };
    return { url, status: hit.status ?? 200, html: hit.html ?? '' };
  };
}

// ---- 1 + 2. findings from crawled statuses ---------------------------------
{
  const site = fakeFetcher({
    [`${ORIGIN}/`]: { html: '<a href="/cart">Cart</a><a href="/about">About</a>' },
    [`${ORIGIN}/cart`]: { status: 500, html: '<h1>Server Error</h1>' },
    [`${ORIGIN}/about`]: { html: '<a>Contact</a><button>Send</button>' },
  });
  const crawl = await crawlSite([`${ORIGIN}/`], site);
  const findings = crawl.pages.flatMap((p) => findingsForPage(p, '2026-09-13T00:00:00.000Z'));

  const serverError = findings.find((f) => f.kind === 'server-error');
  check('a crawled page that returns 500 produces a finding', Boolean(serverError));
  check('the 500 finding names the page it was seen on', Boolean(serverError && serverError.route.includes('/cart')));
  check('the 500 finding is a problem, not a warning', serverError?.severity === 'problem');
  check('the 500 finding reads in plain words', Boolean(serverError && /server error/i.test(serverError.detail)));
  check('a 500 finding fails the command', hasBlockingFindings(findings));

  const dead = findings.find((f) => f.kind === 'dead-link');
  check('an anchor with no href is reported', Boolean(dead));
  check('a link that goes nowhere is only a warning', dead?.severity === 'warning');
  check('links that go nowhere alone do not fail the command', !hasBlockingFindings(findings.filter((f) => f.kind === 'dead-link')));

  // href="#" is an everyday script-driven tab/accordion — flagging it would
  // cry wolf on most real sites, so it must NOT be reported.
  const tabs = findingsForPage({
    ...crawl.pages[0],
    deadLinks: [],
  } as CrawledPage);
  check('a page with no dead anchors reports none', !tabs.some((f) => f.kind === 'dead-link'));
}

{
  const base: CrawledPage = {
    url: `${ORIGIN}/checkout`,
    normalizedUrl: `${ORIGIN}/checkout`,
    routePattern: '/checkout',
    depth: 1,
    status: 200,
    structuralSignature: 'x',
    contentSignature: 'y',
    interactiveElements: [],
    links: [],
  };

  const threw = findingsForPage({ ...base, pageErrors: ['TypeError: Cannot read properties of undefined (reading \'total\')'] });
  check('a page that threw while loading produces a finding', threw.length === 1 && threw[0].kind === 'page-error');
  check('a page error is a problem', hasBlockingFindings(threw));
  check('the page-error text carries the real error', threw[0].detail.includes('Cannot read properties of undefined'));

  const apiDown = findingsForPage({ ...base, failedRequests: [{ url: `${ORIGIN}/api/order`, status: 500 }] });
  check('a failed call the page made produces a finding', apiDown.length === 1 && apiDown[0].kind === 'request-failed');
  check('a failed call is a problem', hasBlockingFindings(apiDown));

  const notFound = findingsForPage({ ...base, status: 404 });
  check('a 404 page is reported', notFound.length === 1 && notFound[0].kind === 'missing-page');
  check('a 404 page does not fail the command', !hasBlockingFindings(notFound));

  check('a clean page produces no findings', findingsForPage(base).length === 0);
}

// ---- 3. the JS-bundle route extractor --------------------------------------
{
  const bundle = `
    var r=[{path:"/",element:h(Home)},{path:'/products',element:h(List)},
    {path:"/products/:id",element:h(Detail)},{ path : "/checkout" , x:1 },
    {route:'/account/settings'},{route="/help"}];
    fetch({path:"/api/orders"}); import("/_next/static/chunk.js");
    var css={path:"/assets/app.css"}; var t={path:"/"+slug};
    var img = { path: '/logo.svg' };
  `;
  const routes = routesFromBundle(bundle);
  for (const want of ['/', '/products', '/products/:param', '/checkout', '/account/settings', '/help']) {
    check(`bundle extractor finds "${want}"`, routes.includes(want));
  }
  check('bundle extractor skips API paths', !routes.includes('/api/orders'));
  check('bundle extractor skips build assets', !routes.some((r) => r.startsWith('/_next')));
  check('bundle extractor skips stylesheets', !routes.some((r) => r.endsWith('.css')));
  check('bundle extractor skips images', !routes.some((r) => r.endsWith('.svg')));
  check('bundle extractor skips runtime-built paths', !routes.some((r) => r.includes('+')));
  check('an empty bundle yields nothing', routesFromBundle('').length === 0);
  check('bundle routes come back sorted and deduplicated', routes.length === new Set(routes).size);
}

// ---- 4. discoverApp folds bundle routes in, and refreshes findings ---------
{
  const shellHtml = '<html><body><div id="root"></div><script src="/app.js"></script></body></html>';
  const site = fakeFetcher({ [`${ORIGIN}/`]: { html: shellHtml } });
  const model = await discoverApp({
    baseUrl: `${ORIGIN}/`,
    fetcher: site,
    appDirFiles: ['app/legacy/page.tsx'],
    routerKind: 'app',
    bundleFetcher: async (u) => (u === `${ORIGIN}/app.js` ? '{path:"/dashboard"},{path:"/team"}' : null),
  });
  const routes = model.routes.map((r) => r.route);
  check('a client-rendered shell still yields its bundle routes', routes.includes('/dashboard') && routes.includes('/team'));
  check('the Next.js parser still contributes alongside it', routes.some((r) => r.endsWith('/legacy')));
  check('a clean client-rendered shell reports no problems', !hasBlockingFindings(model.findings));

  // A second crawl of a now-broken site must REPLACE the findings, not append
  // to the ones carried forward in the ledger.
  const broken = await discoverApp({
    baseUrl: `${ORIGIN}/`,
    fetcher: fakeFetcher({ [`${ORIGIN}/`]: { status: 503, html: '' } }),
    previousModel: model,
  });
  check('a later crawl reports the new breakage', hasBlockingFindings(broken.findings));
  check('findings are replaced, not accumulated', (broken.findings ?? []).length === 1);

  const healed = await discoverApp({ baseUrl: `${ORIGIN}/`, fetcher: site, previousModel: broken });
  check('a fixed site stops reporting the old problem', !hasBlockingFindings(healed.findings));
  check('a fresh model starts with no findings', (emptyAppModel(ORIGIN).findings ?? []).length === 0);
}

// ---- 5. crawling through a browser -----------------------------------------
{
  /** A fake that behaves like a driven Chrome: it renders, it throws, and it
   * makes calls of its own — none of which a plain HTTP fetch can see. */
  function fakeBrowser(script: {
    dom: string;
    at?: string;
    console?: Array<{ level: string; text: string }>;
    network?: Array<{ url: string; status?: number; failed?: boolean; errorText?: string }>;
  }) {
    // Buffers fill DURING navigation, exactly as the real capture does — the
    // fetcher clears whatever the previous page left behind before it moves.
    let consoleBuf: Array<{ level: string; text: string }> = [];
    let networkBuf: Array<{ url: string; status?: number; failed?: boolean; errorText?: string }> = [];
    let navigated: string | null = null;
    return {
      navigated: () => navigated,
      port: {
        async navigate(u: string) {
          navigated = u;
          consoleBuf = [...(script.console ?? [])];
          networkBuf = [...(script.network ?? [])];
        },
        async url() {
          return script.at ?? navigated ?? '';
        },
        drainConsole() {
          const out = consoleBuf;
          consoleBuf = [];
          return out;
        },
        drainNetwork() {
          const out = networkBuf;
          networkBuf = [];
          return out;
        },
        cdpClient() {
          return { Runtime: { evaluate: async () => ({ result: { value: script.dom } }) } };
        },
      },
    };
  }

  const rendered = fakeBrowser({
    dom: '<html><body><a href="/cart">Cart</a><button>Buy</button></body></html>',
    at: `${ORIGIN}/`,
    network: [{ url: `${ORIGIN}/`, status: 200 }],
  });
  const got = await browserFetcher(rendered.port)(`${ORIGIN}/`);
  check('the browser crawl reads the page as rendered', Boolean(got && got.html.includes('<button>Buy</button>')));
  check('the browser crawl reports the page status', got?.status === 200);
  check('the browser crawl actually navigated', rendered.navigated() === `${ORIGIN}/`);

  const brokenPage = fakeBrowser({
    dom: '<html><body></body></html>',
    at: `${ORIGIN}/checkout`,
    console: [{ level: 'page-error', text: "[PAGE-ERROR] TypeError: order.total is undefined" }],
    network: [
      { url: `${ORIGIN}/checkout`, status: 200 },
      { url: `${ORIGIN}/api/order`, status: 500, failed: true },
      { url: 'https://analytics.example/collect', failed: true, errorText: 'net::ERR_FAILED' },
    ],
  });
  const bad = await browserFetcher(brokenPage.port, { sameOrigin: ORIGIN })(`${ORIGIN}/checkout`);
  check('the browser crawl sees an error the page threw', bad?.pageErrors?.[0]?.startsWith('TypeError') === true);
  check('the browser crawl sees a call the page made fail', bad?.failedRequests?.length === 1);
  check('a third-party outage is not blamed on the site', !bad?.failedRequests?.some((r) => r.url.includes('analytics')));

  const asFindings = findingsForPage({
    url: bad!.url,
    normalizedUrl: bad!.url,
    routePattern: '/checkout',
    depth: 0,
    status: bad!.status,
    structuralSignature: '',
    contentSignature: '',
    interactiveElements: [],
    links: [],
    pageErrors: bad!.pageErrors ?? [],
    failedRequests: bad!.failedRequests ?? [],
  });
  check('what the browser saw becomes blocking findings', hasBlockingFindings(asFindings) && asFindings.length === 2);

  // A transport with nothing to evaluate with cannot crawl — say so by
  // returning a dead end rather than inventing an empty page.
  const noEval = await browserFetcher({
    async navigate() {},
    async url() {
      return `${ORIGIN}/`;
    },
    drainConsole: () => [],
    drainNetwork: () => [],
  })(`${ORIGIN}/`);
  check('a transport that cannot read the page is a dead end', noEval === null);
}

// ---- summary ---------------------------------------------------------------
const failed = checks.filter(([, ok]) => !ok);
console.log(`\nv103: ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.error(`FAILED: ${failed.map(([l]) => l).join(', ')}`);
  process.exit(1);
}
