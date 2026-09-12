/* v106 — A33: coverage says what was actually tested.
 *
 * Two halves of the same finding, both of which made coverage under-report by
 * an unknown amount:
 *
 *   (a) the map named a page's controls from the markup (an `id`, a `name`, a
 *       placeholder) while a live run names whatever it clicks the way the
 *       browser's accessibility tree does. "user_email" never matched "Email
 *       address", so a control that HAD been operated looked untested forever.
 *       The browser-driven crawl now reads the names off the same tree.
 *
 *   (b) a page a run reached that the map had never found was counted, called
 *       "unknown", and then dropped — so the ledger reported less surface than
 *       had demonstrably been tested, and the pages only a run can reach
 *       (behind a click, a wizard step, a modal route) stayed invisible.
 *
 * No Chrome and no network: the browser is a canned in-memory fake with an
 * accessibility tree, and the ledger is built by hand.
 */

import {
  applyRunToModel,
  browserFetcher,
  crawlSite,
  emptyAppModel,
  interactiveElementsFromAx,
  upsertCrawledPage,
  type AxNodeLike,
} from '../src/discovery/index.js';
import type { StepRecord } from '../src/report/report.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const ORIGIN = 'https://shop.example';

const step = (over: Partial<StepRecord>): StepRecord => ({
  index: 0,
  action: { type: 'click', nodeId: 'n1' },
  description: 'click',
  ok: true,
  console: [],
  network: [],
  ts: 0,
  ...over,
});

// ---- 1. the tree walker keeps only operable controls, named as the run sees them
console.log('=== v106 1/4: accessible names off the tree ===');
{
  const tree: AxNodeLike = {
    role: 'RootWebArea',
    name: 'Sign in',
    children: [
      { role: 'heading', name: 'Sign in' },
      {
        role: 'form',
        children: [
          { role: 'textbox', name: '  Email   address ' },
          { role: 'textbox', name: 'Password' },
          { role: 'checkbox', name: 'Remember me' },
          { role: 'button', name: 'Sign in' },
        ],
      },
      { role: 'paragraph', name: 'Trouble signing in?' },
      // a repeat of something already collected must not double-count
      { role: 'button', name: 'Sign in' },
    ],
  };
  const els = interactiveElementsFromAx(tree);
  check('non-interactive nodes are not counted as controls', els.every((e) => e.role !== 'heading' && e.role !== 'paragraph'));
  check('four distinct controls found', els.length === 4);
  check('whitespace in an accessible name is normalised', els.some((e) => e.name === 'Email address'));
  check('a repeated role+name is counted once', els.filter((e) => e.name === 'Sign in' && e.role === 'button').length === 1);
  check('an empty tree yields nothing rather than throwing', interactiveElementsFromAx(undefined).length === 0);
}

// ---- 2. a browser-driven crawl uses those names instead of the markup's -----
console.log('\n=== v106 2/4: the map names controls the way a run does ===');
{
  // The markup names this input "user_email" (its id); the accessibility tree
  // names it "Email address" (its label) — exactly the mismatch that broke
  // attribution.
  const html = '<form><label for="user_email">Email address</label><input id="user_email" /><button>Sign in</button></form>';
  const tree: AxNodeLike = {
    role: 'RootWebArea',
    children: [
      { role: 'textbox', name: 'Email address' },
      { role: 'button', name: 'Sign in' },
    ],
  };
  const fake = {
    async navigate() {},
    async url() {
      return `${ORIGIN}/login`;
    },
    drainConsole: () => [],
    drainNetwork: () => [],
    async axTree() {
      return { root: tree };
    },
    cdpClient: () => ({
      Runtime: {
        async evaluate() {
          return { result: { value: html } };
        },
      },
    }),
  };

  const crawl = await crawlSite([`${ORIGIN}/login`], browserFetcher(fake), { maxDepth: 0 });
  const named = crawl.pages[0].interactiveElements;
  check('the control carries its accessible name', named.some((e) => e.role === 'textbox' && e.name === 'Email address'));
  check('the markup-derived id is NOT what got recorded', !named.some((e) => e.name === 'user_email'));

  // …and that name is what a run reports, so the two now join up.
  const model = emptyAppModel(`${ORIGIN}/`);
  upsertCrawledPage(model, crawl.pages[0]);
  const r = applyRunToModel(
    model,
    [step({ url: `${ORIGIN}/login`, target: { role: 'textbox', name: 'Email address' } })],
    'sign-in',
  );
  check('the run’s step is attributed to the mapped control', r.elementsMarked === 1);
}

// ---- 3. no tree available → the markup fallback still works ----------------
console.log('\n=== v106 3/4: a crawl with no tree still records controls ===');
{
  const html = '<button>Place order</button>';
  const fake = {
    async navigate() {},
    async url() {
      return `${ORIGIN}/checkout`;
    },
    drainConsole: () => [],
    drainNetwork: () => [],
    cdpClient: () => ({
      Runtime: {
        async evaluate() {
          return { result: { value: html } };
        },
      },
    }),
  };
  const crawl = await crawlSite([`${ORIGIN}/checkout`], browserFetcher(fake), { maxDepth: 0 });
  check('markup extraction still supplies the controls', crawl.pages[0].interactiveElements.some((e) => e.name === 'Place order'));
}

// ---- 4. a page only the run reached is kept, not discarded ------------------
console.log('\n=== v106 4/4: a route the map never found is added, not dropped ===');
{
  const model = emptyAppModel(`${ORIGIN}/`);
  upsertCrawledPage(model, {
    url: `${ORIGIN}/cart`,
    normalizedUrl: `${ORIGIN}/cart`,
    routePattern: '/cart',
    depth: 0,
    status: 200,
    structuralSignature: 'sig-cart',
    contentSignature: 'c',
    interactiveElements: [{ role: 'button', name: 'Checkout' }],
    links: [],
  });

  const r = applyRunToModel(
    model,
    [
      step({ url: `${ORIGIN}/cart`, target: { role: 'button', name: 'Checkout' } }),
      // the wizard step the crawl can never link to
      step({ index: 1, url: `${ORIGIN}/checkout/step-2` }),
    ],
    'checkout',
  );

  check('the unmapped page is still reported as a gap in the map', r.unknownRoutes.includes(`${ORIGIN}/checkout/step-2`));
  const added = model.routes.find((x) => x.route === `${ORIGIN}/checkout/step-2`);
  check('the unmapped page is now in the ledger', Boolean(added));
  check('it is marked as tested', added?.exercised === true);
  check('the test that reached it is credited', added?.coveredByScripts.includes('checkout') === true);
  check('it stays distinguishable from what the map found', added?.source === 'run');
  check('it contributes no phantom untested controls', (added?.states.length ?? 0) === 0);
  check('both pages count as exercised', r.routesMarked.length === 2);

  // re-running must not duplicate the entry
  applyRunToModel(model, [step({ url: `${ORIGIN}/checkout/step-2` })], 'checkout');
  check('a second run does not duplicate it', model.routes.filter((x) => x.route === `${ORIGIN}/checkout/step-2`).length === 1);
}

// ---- summary ---------------------------------------------------------------
const failed = checks.filter(([, ok]) => !ok);
console.log(`\nv106: ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.error(`FAILED: ${failed.map(([l]) => l).join(', ')}`);
  process.exit(1);
}
