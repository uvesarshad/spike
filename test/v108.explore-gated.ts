/* v107 — E7: the exploration pass over state that only exists after a click.
 *
 * The map could only ever follow links, so everything behind a click — a
 * pop-up, a "show more" section, a tab that swaps the content, step 2 of a
 * form — was invisible to it, and coverage quoted a number for an app it had
 * only half seen. This suite covers the pass that opens that surface:
 *
 *   1. a collapsed section the stub model decides to click lands in the
 *      ledger as another state of that page, with its newly-revealed controls
 *      and the name of what revealed it;
 *   2. a click that moves to a new address lands as a new route, tagged as
 *      found by exploring rather than by the crawl;
 *   3. a page with nothing worth trying costs exactly one model call and no
 *      clicks — and a page with nothing offerable at all costs none;
 *   4. the budgets hold: per page, and for the whole pass, even against a
 *      model that would happily keep clicking forever;
 *   5. destructive-looking controls are never even offered, and a click that
 *      leaves the site records nothing;
 *   6. it all ties together through discoverApp, folding into the same model
 *      the crawl fills.
 *
 * No Chrome, no network, no model: the browser is a canned in-memory fake and
 * the "model" is a function returning a fixed decision.
 */

import { normalizeUrlForActionCache } from '../src/cache/action-cache.js';
import {
  buildExplorePrompt,
  discoverApp,
  emptyAppModel,
  makeInteractionExplorer,
  offerableControls,
  parseExploreDecision,
  upsertExploredState,
  type ExploreAxNode,
  type ExploreBrowser,
  type Fetched,
  type InteractionGatedCandidate,
} from '../src/discovery/index.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const ORIGIN = 'https://app.test';
const norm = (u: string) => normalizeUrlForActionCache(u);

/* --- the fake browser ------------------------------------------------------
 * A tiny scripted page machine: each address has a current control tree, and
 * clicking a given control either swaps that tree (a section expands) or
 * moves to another address (a wizard step). */

interface ClickEffect {
  /** Replaces the tree at the current address. */
  tree?: ExploreAxNode;
  /** Moves to this address instead. */
  goto?: string;
}

class FakeBrowser implements ExploreBrowser {
  navigations: string[] = [];
  clicks: string[] = [];
  current = '';
  constructor(
    private trees: Map<string, ExploreAxNode>,
    private effects: Map<string, ClickEffect> = new Map(),
  ) {}
  async navigate(url: string): Promise<void> {
    this.navigations.push(url);
    this.current = url;
  }
  async url(): Promise<string> {
    return this.current;
  }
  async axTree(): Promise<{ root: ExploreAxNode }> {
    const tree = this.trees.get(this.current);
    if (!tree) throw new Error(`no page at ${this.current}`);
    return { root: tree };
  }
  async click(nodeId: string): Promise<void> {
    this.clicks.push(`${this.current}|${nodeId}`);
    const effect = this.effects.get(`${this.current}|${nodeId}`);
    if (!effect) return; // a click that does nothing observable
    if (effect.tree) this.trees.set(this.current, effect.tree);
    if (effect.goto) this.current = effect.goto;
  }
}

const candidate = (route: string, name: string): InteractionGatedCandidate => ({
  route,
  role: 'button',
  name,
  reason: 'button-like control with no discoverable navigation target — candidate for AI exploration',
});

/* ===================== 1/6: a collapsed section opens ===================== */
console.log('=== v107 1/6: something behind a click enters the ledger ===');
{
  const home = norm(`${ORIGIN}/`);
  const collapsed: ExploreAxNode = {
    role: 'RootWebArea',
    name: 'Home',
    children: [{ id: 'n1', role: 'button', name: 'Show more' }],
  };
  const expanded: ExploreAxNode = {
    role: 'RootWebArea',
    name: 'Home',
    children: [
      { id: 'n1', role: 'button', name: 'Show more' },
      { id: 'n2', role: 'region', name: 'Plans', children: [{ id: 'n3', role: 'link', name: 'Pricing details' }] },
    ],
  };
  const browser = new FakeBrowser(new Map([[home, collapsed]]), new Map([[`${home}|n1`, { tree: expanded }]]));

  let asked = 0;
  const explore = makeInteractionExplorer({
    browser,
    planner: {
      async planJson() {
        asked++;
        return asked === 1 ? { action: 'click', control: 'n1', why: 'looks collapsed' } : { action: 'done' };
      },
    },
  });

  const result = await explore([candidate(home, 'Show more')]);
  check('it opens the page it was pointed at', browser.navigations[0] === home);
  check('it clicks the control the model picked', browser.clicks.includes(`${home}|n1`));
  check('what appeared is reported back as a state of that page', result.states.length === 1 && result.states[0].route === home);
  check(
    'the newly-revealed control is in it',
    result.states[0].elements.some((e) => e.role === 'link' && e.name === 'Pricing details'),
  );
  check('the state remembers what revealed it', result.states[0].revealedBy === 'Show more');

  const model = emptyAppModel(ORIGIN);
  upsertExploredState(model, result.states[0]);
  const route = model.routes.find((r) => r.route === home);
  check('folding it into the ledger records the control there too', route?.states[0]?.elements.some((e) => e.name === 'Pricing details') === true);
  check('a page the crawl never had is tagged as found by exploring', route?.source === 'explore');
}

/* ===================== 2/6: a click that moves to a new address ===================== */
console.log('\n=== v107 2/6: a wizard step becomes a route ===');
{
  const start = norm(`${ORIGIN}/signup`);
  const step2 = norm(`${ORIGIN}/signup/details`);
  const trees = new Map<string, ExploreAxNode>([
    [start, { role: 'RootWebArea', name: 'Sign up', children: [{ id: 'n1', role: 'button', name: 'Continue' }] }],
    [step2, { role: 'RootWebArea', name: 'Your details', children: [{ id: 'n5', role: 'textbox', name: 'Full name' }] }],
  ]);
  const browser = new FakeBrowser(trees, new Map([[`${start}|n1`, { goto: step2 }]]));

  let asked = 0;
  const explore = makeInteractionExplorer({
    browser,
    planner: {
      async planJson() {
        asked++;
        return asked === 1 ? { action: 'click', control: 'n1' } : { action: 'done' };
      },
    },
  });

  const result = await explore([candidate(start, 'Continue')]);
  check('the address behind the step is recorded', result.states.some((s) => s.route === step2));
  const model = emptyAppModel(ORIGIN);
  for (const s of result.states) upsertExploredState(model, s);
  check('it enters the ledger as its own route', model.routes.some((r) => r.route === step2 && r.source === 'explore'));
  check('its controls come with it', model.routes.find((r) => r.route === step2)?.states[0]?.elements.some((e) => e.name === 'Full name') === true);
}

/* ===================== 3/6: nothing to try costs one call ===================== */
console.log('\n=== v107 3/6: a page with nothing to open is cheap ===');
{
  const page = norm(`${ORIGIN}/about`);
  const tree: ExploreAxNode = {
    role: 'RootWebArea',
    name: 'About',
    children: [{ id: 'n1', role: 'button', name: 'Print this page' }],
  };
  const browser = new FakeBrowser(new Map([[page, tree]]));
  let asked = 0;
  const explore = makeInteractionExplorer({
    browser,
    planner: {
      async planJson() {
        asked++;
        return { action: 'done', why: 'nothing here hides anything' };
      },
    },
  });

  const result = await explore([candidate(page, 'Print this page')]);
  check('it asks exactly once and then leaves the page alone', asked === 1 && result.modelCalls === 1);
  check('nothing was clicked', browser.clicks.length === 0 && result.actionsUsed === 0);
  check('nothing was invented for the ledger', result.states.length === 0);

  // And a page with no openable control at all costs nothing whatsoever.
  const bare = norm(`${ORIGIN}/legal`);
  const bareBrowser = new FakeBrowser(new Map([[bare, { role: 'RootWebArea', name: 'Legal', children: [{ id: 'n1', role: 'link', name: 'Home' }] }]]));
  let bareAsked = 0;
  const bareResult = await makeInteractionExplorer({
    browser: bareBrowser,
    planner: {
      async planJson() {
        bareAsked++;
        return { action: 'done' };
      },
    },
  })([candidate(bare, 'nothing')]);
  check('a page whose only controls are links is not even asked about', bareAsked === 0 && bareResult.modelCalls === 0);
}

/* ===================== 4/6: the budgets hold ===================== */
console.log('\n=== v107 4/6: the budget is never exceeded ===');
{
  /** A page that grows a brand-new control every time anything is clicked, so
   * a model that keeps saying "click" always has something new to pick. */
  const growingPage = (url: string): FakeBrowser => {
    let generation = 0;
    const treeFor = (n: number): ExploreAxNode => ({
      role: 'RootWebArea',
      name: 'Endless',
      children: Array.from({ length: n + 1 }, (_, i) => ({ id: `n${i}`, role: 'button', name: `Open section ${i}` })),
    });
    const trees = new Map<string, ExploreAxNode>([[url, treeFor(0)]]);
    const browser = new FakeBrowser(trees);
    const realClick = browser.click.bind(browser);
    browser.click = async (nodeId: string) => {
      await realClick(nodeId);
      generation++;
      trees.set(url, treeFor(generation));
    };
    return browser;
  };

  const greedyPlanner = {
    calls: 0,
    async planJson(prompt: string) {
      this.calls++;
      const first = /^(n\d+) /m.exec(prompt.split('Controls on the page right now:')[1] ?? '');
      return { action: 'click', control: first?.[1] ?? 'n0' };
    },
  };

  const one = norm(`${ORIGIN}/one`);
  const single = await makeInteractionExplorer({
    browser: growingPage(one),
    planner: greedyPlanner,
    maxActionsPerPage: 2,
    maxActionsPerRun: 99,
  })([candidate(one, 'Open section 0')]);
  check('a single page stops at its own cap however much there is to click', single.actionsUsed === 2);
  check('and it says it stopped early rather than claiming it was finished', single.stoppedAtCap === true);

  // Three pages, two clicks each allowed, but only three clicks for the pass.
  const routes = ['/a', '/b', '/c'].map((p) => norm(ORIGIN + p));
  const trees = new Map<string, ExploreAxNode>();
  for (const r of routes) trees.set(r, { role: 'RootWebArea', name: r, children: [{ id: 'n0', role: 'button', name: 'Open section 0' }] });
  const multi = new FakeBrowser(trees);
  const realClick = multi.click.bind(multi);
  let gen = 0;
  multi.click = async (nodeId: string) => {
    await realClick(nodeId);
    gen++;
    trees.set(multi.current, {
      role: 'RootWebArea',
      name: multi.current,
      children: Array.from({ length: gen + 1 }, (_, i) => ({ id: `n${i}`, role: 'button', name: `Open section ${i}` })),
    });
  };
  const pass = await makeInteractionExplorer({
    browser: multi,
    planner: greedyPlanner,
    maxActionsPerPage: 2,
    maxActionsPerRun: 3,
  })(routes.map((r) => candidate(r, 'Open section 0')));
  check('the whole pass stops at its own cap across pages', pass.actionsUsed === 3 && multi.clicks.length === 3);
  check('and it never looks at more pages than it has budget for', pass.pagesVisited <= 3);

  const capped = await makeInteractionExplorer({
    browser: growingPage(one),
    planner: greedyPlanner,
    maxActionsPerPage: 0,
  })([candidate(one, 'Open section 0')]);
  check('a zero budget spends nothing at all', capped.actionsUsed === 0 && capped.modelCalls === 0);
}

/* ===================== 5/6: what it refuses to do ===================== */
console.log('\n=== v107 5/6: it stays out of trouble ===');
{
  const tree: ExploreAxNode = {
    role: 'RootWebArea',
    name: 'Account',
    children: [
      { id: 'n1', role: 'button', name: 'Delete account' },
      { id: 'n2', role: 'button', name: 'Sign out' },
      { id: 'n3', role: 'button', name: 'Place order' },
      { id: 'n4', role: 'button', name: 'Show more' },
      { id: 'n5', role: 'link', name: 'Home' },
    ],
  };
  const offered = offerableControls(tree);
  check('destructive-looking controls are never offered to the model', !offered.some((c) => /delete|sign out|place order/i.test(c.name)));
  check('plain links are left to the crawl', !offered.some((c) => c.role === 'link'));
  check('the harmless expander is offered', offered.some((c) => c.name === 'Show more'));

  const prompt = buildExplorePrompt({ url: `${ORIGIN}/account` }, offered, ['button|show more']);
  check('the question names the page and its controls', prompt.includes(`${ORIGIN}/account`) && prompt.includes('n4 button "Show more"'));
  check('and tells the model what it already tried', prompt.includes('button|show more'));

  check('an unusable answer means stop, not crash', parseExploreDecision('nonsense').action === 'done');
  check('a click with no control named means stop', parseExploreDecision({ action: 'click' }).action === 'done');
  check('a well-formed click is honoured', parseExploreDecision({ action: 'click', control: ' n7 ' }).control === 'n7');

  // A click that leaves the site: nothing off-site enters this app's map.
  const here = norm(`${ORIGIN}/partners`);
  const away = 'https://elsewhere.test/landing';
  const trees = new Map<string, ExploreAxNode>([
    [here, { role: 'RootWebArea', name: 'Partners', children: [{ id: 'n1', role: 'button', name: 'Open partner portal' }] }],
    [away, { role: 'RootWebArea', name: 'Elsewhere', children: [{ id: 'n9', role: 'button', name: 'Start' }] }],
  ]);
  const browser = new FakeBrowser(trees, new Map([[`${here}|n1`, { goto: away }]]));
  const result = await makeInteractionExplorer({
    browser,
    planner: { async planJson() { return { action: 'click', control: 'n1' }; } },
  })([candidate(here, 'Open partner portal')]);
  check('a click that leaves the site records nothing', result.states.length === 0);
  check('and it goes back to where it was', browser.navigations[browser.navigations.length - 1] === here);
}

/* ===================== 6/6: end to end through discoverApp ===================== */
console.log('\n=== v107 6/6: mapping folds it in with everything else ===');
{
  const homeUrl = `${ORIGIN}/`;
  const home = norm(homeUrl);
  const pages: Record<string, string> = {
    [homeUrl]: '<html><body><a href="/about">About</a><button>Show more</button></body></html>',
    [`${ORIGIN}/about`]: '<html><body><a href="/">Home</a><p>About us</p></body></html>',
  };
  const fetcher = async (url: string): Promise<Fetched | null> => {
    const html = pages[url];
    if (html === undefined) return { url, status: 404, html: '' };
    return { url, status: 200, html };
  };

  const collapsed: ExploreAxNode = { role: 'RootWebArea', name: 'Home', children: [{ id: 'n1', role: 'button', name: 'Show more' }] };
  const expanded: ExploreAxNode = {
    role: 'RootWebArea',
    name: 'Home',
    children: [
      { id: 'n1', role: 'button', name: 'Show more' },
      { id: 'n2', role: 'dialog', name: 'What you get', children: [{ id: 'n3', role: 'button', name: 'Accept and continue' }] },
    ],
  };
  const browser = new FakeBrowser(new Map([[home, collapsed]]), new Map([[`${home}|n1`, { tree: expanded }]]));
  let asked = 0;

  const model = await discoverApp({
    baseUrl: homeUrl,
    fetcher,
    crawl: { maxDepth: 1, maxPages: 10 },
    exploreInteractionGated: makeInteractionExplorer({
      browser,
      planner: {
        async planJson() {
          asked++;
          return asked === 1 ? { action: 'click', control: 'n1' } : { action: 'done' };
        },
      },
      maxActionsPerPage: 1,
    }),
  });

  const route = model.routes.find((r) => r.route === home);
  check('the crawled page is still there, still tagged as crawled', route?.source === 'crawl');
  check('the page now carries a second look at itself', (route?.states.length ?? 0) === 2);
  check(
    'the control that only exists once something is clicked is in the ledger',
    route?.states.some((s) => s.elements.some((e) => e.name === 'Accept and continue')) === true,
  );
  check('and the ledger says what opened it', route?.states.some((s) => s.revealedBy === 'Show more') === true);

  // Re-mapping merges instead of duplicating.
  const browser2 = new FakeBrowser(new Map([[home, collapsed]]), new Map([[`${home}|n1`, { tree: expanded }]]));
  let asked2 = 0;
  const again = await discoverApp({
    baseUrl: homeUrl,
    fetcher,
    crawl: { maxDepth: 1, maxPages: 10 },
    previousModel: model,
    exploreInteractionGated: makeInteractionExplorer({
      browser: browser2,
      planner: {
        async planJson() {
          asked2++;
          return asked2 === 1 ? { action: 'click', control: 'n1' } : { action: 'done' };
        },
      },
      maxActionsPerPage: 1,
    }),
  });
  check('mapping again does not duplicate what it already opened', (again.routes.find((r) => r.route === home)?.states.length ?? 0) === 2);

  // And a caller with no budget for it gets exactly the old behaviour.
  const plain = await discoverApp({ baseUrl: homeUrl, fetcher, crawl: { maxDepth: 1, maxPages: 10 } });
  check('leaving the pass off maps the site exactly as before', (plain.routes.find((r) => r.route === home)?.states.length ?? 0) === 1);
}

/* ===================== summary ===================== */
const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v107 exploration checks passed`);
process.exit(failed.length ? 1 : 0);
