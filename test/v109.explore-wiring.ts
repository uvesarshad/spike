/* v109 — E7's last mile: the switch that turns the exploration pass on.
 *
 * v108 proved the pass itself. This suite covers the thing that was missing
 * after it: nothing actually switched it on. Both places that walk a site —
 * the `map`/`check` commands and the panel's "Check this site" — now build
 * the pass through one shared helper, so the decision reads the same in both
 * and neither has to know that "off" means leaving an option out.
 *
 *   1. switched on, a walk surfaces what is only there after a click, and the
 *      extra content lands in the same map the walk fills;
 *   2. switched off, the very same walk produces the pre-E7 map and costs
 *      nothing — no clicks, no model calls;
 *   3. the switch is off whenever there is nothing to drive with (no browser)
 *      or nothing to decide with (no model), so a caller can pass either
 *      through unconditionally.
 *
 * No Chrome, no network, no model: the browser is a canned in-memory fake
 * (the same shape v108 uses) and the "model" is a function returning a fixed
 * decision.
 */

import { normalizeUrlForActionCache } from '../src/cache/action-cache.js';
import { discoverApp, explorationOptions, type ExploreAxNode, type ExploreBrowser, type Fetched } from '../src/discovery/index.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const ORIGIN = 'https://shop.test';
const norm = (u: string) => normalizeUrlForActionCache(u);
const HOME_URL = `${ORIGIN}/`;
const HOME = norm(HOME_URL);

/* The site as the walk sees it: two linked pages of plain markup, one of
 * which carries a button the walk can never follow. */
const PAGES: Record<string, string> = {
  [HOME_URL]: '<html><body><a href="/about">About</a><button>Show delivery options</button></body></html>',
  [`${ORIGIN}/about`]: '<html><body><a href="/">Home</a><p>About us</p></body></html>',
};

const fetcher = async (url: string): Promise<Fetched | null> => {
  const html = PAGES[url];
  if (html === undefined) return { url, status: 404, html: '' };
  return { url, status: 200, html };
};

/* The same page in a browser: a collapsed section that opens on click. */
const COLLAPSED: ExploreAxNode = {
  role: 'RootWebArea',
  name: 'Home',
  children: [{ id: 'n1', role: 'button', name: 'Show delivery options' }],
};
const OPENED: ExploreAxNode = {
  role: 'RootWebArea',
  name: 'Home',
  children: [
    { id: 'n1', role: 'button', name: 'Show delivery options' },
    { id: 'n2', role: 'region', name: 'Delivery', children: [{ id: 'n3', role: 'button', name: 'Next day' }] },
  ],
};

class FakeBrowser implements ExploreBrowser {
  clicks: string[] = [];
  current = '';
  private tree: ExploreAxNode = COLLAPSED;
  async navigate(url: string): Promise<void> {
    this.current = url;
  }
  async url(): Promise<string> {
    return this.current;
  }
  async axTree(): Promise<{ root: ExploreAxNode }> {
    return { root: this.tree };
  }
  async click(nodeId: string): Promise<void> {
    this.clicks.push(nodeId);
    if (nodeId === 'n1') this.tree = OPENED;
  }
}

/** A model that opens the first thing it is offered and then stops. */
function onceThenDone(): { planJson: () => Promise<unknown>; calls: number } {
  const planner = {
    calls: 0,
    async planJson(): Promise<unknown> {
      planner.calls++;
      return planner.calls === 1 ? { action: 'click', control: 'n1' } : { action: 'done' };
    },
  };
  return planner;
}

/* ============== 1/3: switched on, the hidden part is mapped ============== */
console.log('=== v109 1/3: with the switch on, what is behind a click is in the map ===');
{
  const browser = new FakeBrowser();
  const planner = onceThenDone();

  const model = await discoverApp({
    baseUrl: HOME_URL,
    fetcher,
    crawl: { maxDepth: 1, maxPages: 10 },
    ...explorationOptions({ enabled: true, browser, planner, allowedOrigin: ORIGIN, maxActionsPerPage: 1 }),
  });

  const home = model.routes.find((r) => r.route === HOME);
  check('the walk itself still produced the page', home !== undefined && home.source === 'crawl');
  check('the page now carries a second look at itself', (home?.states.length ?? 0) === 2);
  check(
    'the control that only exists after a click is in the map',
    home?.states.some((s) => s.elements.some((e) => e.name === 'Next day')) === true,
  );
  check('the map says what opened it', home?.states.some((s) => s.revealedBy === 'Show delivery options') === true);
  check('something really was pressed to find it', browser.clicks.includes('n1'));
}

/* ============== 2/3: switched off, nothing changes and nothing is spent === */
console.log('\n=== v109 2/3: with the switch off it is the old walk, for free ===');
{
  const browser = new FakeBrowser();
  const planner = onceThenDone();

  const model = await discoverApp({
    baseUrl: HOME_URL,
    fetcher,
    crawl: { maxDepth: 1, maxPages: 10 },
    ...explorationOptions({ enabled: false, browser, planner, allowedOrigin: ORIGIN }),
  });

  const home = model.routes.find((r) => r.route === HOME);
  check('the walk still finds the linked pages', model.routes.some((r) => r.route === norm(`${ORIGIN}/about`)));
  check('the page has exactly the one look the walk gave it', (home?.states.length ?? 0) === 1);
  check('nothing hidden was added', home?.states.some((s) => s.elements.some((e) => e.name === 'Next day')) !== true);
  check('nothing was pressed and nothing was asked', browser.clicks.length === 0 && planner.calls === 0);
}

/* ============== 3/3: the switch is safe to pass through blind ============= */
console.log('\n=== v109 3/3: no browser or no model means off, never a crash ===');
{
  const planner = onceThenDone();
  check('no browser to drive → off', explorationOptions({ enabled: true, browser: null, planner }).exploreInteractionGated === undefined);
  check('no model to decide with → off', explorationOptions({ enabled: true, browser: new FakeBrowser(), planner: undefined }).exploreInteractionGated === undefined);
  check(
    'everything present and asked for → on',
    typeof explorationOptions({ enabled: true, browser: new FakeBrowser(), planner }).exploreInteractionGated === 'function',
  );
  check('off spreads to nothing at all', Object.keys(explorationOptions({ enabled: false, browser: new FakeBrowser(), planner })).length === 0);
}

/* ---------------------------------------------------------------------- */
const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  for (const [label] of failed) console.error(`FAILED: ${label}`);
  process.exit(1);
}
