/* v105 — "Check this site": the zero-input way in (A24, second task).
 *
 * Every other entry point asks the user to say what to test. This one asks
 * nothing: find the pages on the site, look at each one, and answer "is any of
 * this broken?" — a health + coverage sentence, not a pass/fail on one flow.
 *
 * Covers (no Chrome, no network, no keys — the runner is a stub):
 *   1. which mapped pages a check actually opens, and in what order
 *   2. the words each page visit is asked to check: look-only, plain English
 *   3. the closing sentence counts pages checked, controls FOUND and problems
 *   4. the per-page runs go through the A8 fan-out orchestrator — one budgeted
 *      run each, one aggregated verdict — not a second loop of our own
 *   5. the panel and the command line ask the same question, and the panel's
 *      check is look-only whatever the click-and-type box says
 *   6. the no-helper path caps the crawl and says why
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkInstruction,
  checkTargets,
  emptyAppModel,
  renderCheckSummary,
  upsertStaticRoute,
  LITE_CHECK_PAGES,
  LITE_CAP_NOTE,
  type AppModel,
} from '../src/discovery/index.js';
import { flowsFromRoutes, runFanOut } from '../src/orchestrator/fan-out.js';
import type { RunVerdict } from '../src/report/report.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const ORIGIN = 'https://shop.example';

function modelWith(routes: string[]): AppModel {
  const m = emptyAppModel(`${ORIGIN}/`);
  for (const r of routes) upsertStaticRoute(m, r);
  return m;
}

// ---- 1. which pages a check opens ------------------------------------------
{
  const model = modelWith([
    `${ORIGIN}/account/billing/invoices`,
    `${ORIGIN}/cart`,
    `${ORIGIN}/`,
    '/products/:param', // a pattern, not an address
    '/help/*',
    'https://someone-else.example/tracker',
    `${ORIGIN}/about`,
  ]);
  const targets = checkTargets(model, `${ORIGIN}/`);
  const names = targets.map((t) => t.name);

  check('the page a person lands on is checked first', names[0] === '/');
  check('shallow pages are checked before deep ones', names.indexOf('/cart') < names.indexOf('/account/billing/invoices'));
  check('a route pattern with a placeholder is not opened', !names.some((n) => n.includes(':')));
  check('a catch-all route is not opened', !names.some((n) => n.includes('*')));
  check('another site is never opened', !targets.some((t) => !t.url.startsWith(ORIGIN)));
  check('every page is a full address', targets.every((t) => t.url.startsWith('https://')));

  check('the page cap is honoured', checkTargets(model, `${ORIGIN}/`, 2).length === 2);
  check('a cap of zero still checks one page', checkTargets(model, `${ORIGIN}/`, 0).length === 1);
  check('an unusable starting address checks nothing', checkTargets(model, 'not a url').length === 0);
  check('a map with nothing in it checks nothing', checkTargets(emptyAppModel(), `${ORIGIN}/`).length === 0);

  // The same page twice (once as a crawl address, once as a static route) is
  // one page — checking it twice would double the bill and the page count.
  const dupes = modelWith([`${ORIGIN}/cart`, `${ORIGIN}/cart#top`]);
  check('the same page is never checked twice', checkTargets(dupes, `${ORIGIN}/`).length === 1);
}

// ---- 2. what each page is asked ---------------------------------------------
{
  const words = checkInstruction(`${ORIGIN}/cart`);
  check('the instruction names the page', words.includes(`${ORIGIN}/cart`));
  check('the instruction forbids clicking and typing', /do not click, type or submit/i.test(words));
  check('the instruction asks about errors', /error/i.test(words));
  check('the instruction asks about broken or missing things', /broken or missing/i.test(words));
  check('the instruction asks about controls that lead nowhere', /lead nowhere/i.test(words));

  // §1.5: nothing a non-developer sees may speak engine.
  const banned = ['daemon', 'CDP', 'bridge', 'BYOK', 'lite mode', 'navigator', 'brain', 'planner', 'oracle', 'metamorphic', 'invariant', 'rung', 'a11y', 'allowedHosts', 'SPIKE_'];
  const surfaces = [words, LITE_CAP_NOTE, renderCheckSummary({ pagesChecked: 3, controlsFound: 9, problems: 1 })];
  for (const bad of banned) {
    check(`no user-facing check copy says "${bad}"`, !surfaces.some((t) => t.toLowerCase().includes(bad.toLowerCase())));
  }
}

// ---- 3. the closing sentence -------------------------------------------------
{
  const clean = renderCheckSummary({ pagesChecked: 11, controlsFound: 84, problems: 0 });
  check('a clean check counts pages and controls', clean.startsWith('Checked 11 pages and 84 controls on them;'));
  check('a clean check says nothing looked broken', clean.includes('nothing looked broken'));

  const one = renderCheckSummary({ pagesChecked: 1, controlsFound: 1, problems: 1 });
  check('singulars read correctly', one.startsWith('Checked 1 page and 1 control on them;'));
  check('one problem reads as one problem', one.includes('1 problem'));

  const many = renderCheckSummary({ pagesChecked: 11, controlsFound: 84, problems: 2 });
  check('several problems are counted', many.includes('2 problems'));

  const capped = renderCheckSummary({ pagesChecked: 10, controlsFound: 30, problems: 0, capped: true });
  check('a shortened check explains the cap', capped.includes(LITE_CAP_NOTE));
  check('the cap note names the number of pages', LITE_CAP_NOTE.includes(String(LITE_CHECK_PAGES)));
  check('an uncapped check adds no note', !clean.includes(LITE_CAP_NOTE));
}

// ---- 4. the runs go through the fan-out orchestrator -------------------------
{
  const model = modelWith([`${ORIGIN}/`, `${ORIGIN}/cart`, `${ORIGIN}/about`]);
  const targets = checkTargets(model, `${ORIGIN}/`);
  const flows = flowsFromRoutes(
    targets.map((t) => ({ url: t.url, name: t.name })),
    { baseUrl: `${ORIGIN}/`, maxFlows: targets.length, instruction: (_r, address) => checkInstruction(address) },
  );
  check('one test per page', flows.length === targets.length);
  check('the orchestrator keeps the page order', flows.every((f, i) => f.task.includes(targets[i].url)));

  const verdicts: RunVerdict[] = ['pass', 'fail', 'pass'];
  const seen: string[] = [];
  const outcome = await runFanOut(flows, {
    runFlow: async (flow, i) => {
      seen.push(flow.task);
      return {
        verdict: verdicts[i],
        reason: verdicts[i] === 'fail' ? 'The cart page showed an error.' : 'Looked fine.',
        url: targets[i].url,
        steps: [{ index: 0, action: { type: 'navigate', url: targets[i].url }, ok: true, url: targets[i].url } as never],
      };
    },
  });
  check('every page was actually visited', seen.length === 3);
  check('one broken page makes the whole check a fail', outcome.verdict === 'fail');
  check('the fan-out counts the pages it got through', outcome.coverage.flowsAttempted === 3);
  check('the fan-out counts distinct pages reached', outcome.coverage.pagesVisited === 3);

  const summary = renderCheckSummary({
    pagesChecked: outcome.coverage.flowsAttempted,
    controlsFound: 42,
    problems: outcome.flows.filter((f) => f.verdict === 'fail').length,
  });
  check('the sentence reports the one broken page', summary === 'Checked 3 pages and 42 controls on them; 1 problem — it is listed below.');

  // A look-only check presses nothing, so counting controls OPERATED would
  // always say zero — which is exactly why the sentence counts controls found.
  check('a look-only sweep operates no controls', outcome.coverage.controlsExercised === 0);
}

// ---- 5. the panel asks the same question, look-only --------------------------
{
  const panelSrc = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'panel.js'), 'utf8');
  const panelHtml = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'panel.html'), 'utf8');
  const swSrc = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'sw.js'), 'utf8');
  const cliSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'cli.ts'), 'utf8');

  check('the panel offers a "Check this site" button', panelHtml.includes('id="checkSiteBtn"'));
  check('the button says what it does in plain words', /look at every page and tell me what's broken/i.test(panelHtml));
  check('the button asks the worker to find the pages', panelSrc.includes("kind: 'check-site'"));
  check('the panel handles the page list', panelSrc.includes("case 'check-pages'"));
  check('the panel handles a failure to look around', panelSrc.includes("case 'check-error'"));
  check('a check is look-only whatever the click-and-type box says', panelSrc.includes('flowQueue.lookOnly) || !consentToggle.checked'));
  check('the panel reuses the existing run queue', panelSrc.includes('flowQueue = {') && panelSrc.includes('lookOnly: true'));

  check('the worker asks the helper when there is one', swSrc.includes("sendRequest('vibe.check.site'"));
  check('the worker can find pages without the helper', swSrc.includes('findPagesInBrowser'));
  check('the no-helper crawl carries the sign-in', swSrc.includes("credentials: 'include'"));
  check(`the no-helper crawl stops at ${LITE_CHECK_PAGES} pages`, swSrc.includes(`const LITE_CHECK_PAGES = ${LITE_CHECK_PAGES}`));
  check('the no-helper cap is reported back to the panel', swSrc.includes('liteCap'));

  // The words one page is asked to check must be identical on both paths —
  // a check has to ask the same question with or without the helper.
  const swWords = swSrc.slice(swSrc.indexOf('function checkInstructionFor'));
  check('the worker asks the same question as the command line', swWords.includes('Do not click, type or submit anything.'));

  check('the command line has a `spike check`', cliSrc.includes(".command('check')"));
  // The check engine moved out of cli.ts into src/discovery/run-check.ts (shared with the MCP site_check tool).
  const checkSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'discovery', 'run-check.ts'), 'utf8');
  check('`spike check` runs through the shared check engine', cliSrc.includes('runSiteCheck('));
  check('`spike check` runs look-only', /readOnly: true, \/\/ a check nobody asked for/.test(checkSrc));
  check('`spike check` aggregates through the orchestrator', checkSrc.includes('runFanOut(flows'));
  check('`spike check` can use a saved sign-in', cliSrc.includes("'--storage-state <path>', 'load a saved sign-in first"));
}

// ---- 6. the daemon side ------------------------------------------------------
{
  const serviceSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'vibe', 'service.ts'), 'utf8');
  check('the helper answers a check request', serviceSrc.includes("onRequest('vibe.check.site'"));
  check('only the paired panel may ask for a check', serviceSrc.includes('vibe.check.site: unauthenticated client'));
  check('a check never runs on top of another test', serviceSrc.includes("throw new Error('a test is already running')"));
  check('the helper walks the site in the real browser', serviceSrc.includes('browserFetcher(session.browser'));
  check('the helper hands back what it found', serviceSrc.includes('controlsFound') && serviceSrc.includes('capped:'));
}

// ---- summary ---------------------------------------------------------------
const failed = checks.filter(([, ok]) => !ok);
console.log(`\nv105: ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.error(`FAILED: ${failed.map(([l]) => l).join(', ')}`);
  process.exit(1);
}
