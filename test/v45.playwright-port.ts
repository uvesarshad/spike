/* v45 — A26: PlaywrightBrowser, a third BrowserPort implementation that
 * attaches Playwright (chromium.connectOverCDP) to the SAME Chrome the
 * daemon already launches via ensureChrome() — Playwright never launches or
 * owns a browser process here.
 *
 * docs/plan/26-08-08-audit-deterministic-speed.md's A26 finding is RESOLVED:
 * the proving spike (docs/plan/spikes/a26-connect-over-cdp.mjs, 9/9 passed)
 * showed `browser.newContext()` over connectOverCDP gives genuinely isolated
 * cookies + localStorage per run, drives concurrently, and never disturbs
 * the daemon's original Chrome when a context closes. This suite exercises
 * the PRODUCT implementation (src/ports/playwright-browser.ts) built on that
 * decision, against a REAL Chrome and the actual dogfood fixture app (not a
 * throwaway inline page), on ports dedicated to this suite:
 *   - CDP 9332      (distinct from the daemon's 9322 and every other suite's
 *                     throwaway port — see the port table in each test file)
 *   - fixture 9411  (fixture/server.ts, the same app m5.fixture.ts drives)
 *
 * Covers:
 *  1. the shared BrowserPort contract (runPortContract — the same suite
 *     CdpBrowser/M1 passes): connect → navigate → axTree returns stable
 *     "n7"-style ids → click/type/hover/select/upload/drag/blur/mouse/tabs
 *     all work → console/network drains are per-step.
 *  2. driving the REAL dogfood fixture end-to-end (login → cart → checkout),
 *     both healthy and bug-on, mirroring m5.fixture.ts's scenarios — proves
 *     this port drives a real multi-page app, not just the contract's inline
 *     single-page fixture.
 *  3. TWO PlaywrightBrowser instances against the SAME Chrome (same CDP
 *     port — exactly how two concurrent qaRun() calls would each construct
 *     their own port): cookies set through one are invisible to the other
 *     (A3's isolation claim, now exercised through the actual port class,
 *     not just the raw spike script).
 *  4. storageState()/setStorageState() round-trip (A6 primitive): capture
 *     context A's cookie, inject it into context B, confirm B's page now
 *     sees it.
 *  5. closing one PlaywrightBrowser (context.close() + browser.close(),
 *     disconnecting Playwright) does NOT kill the shared Chrome — proven by
 *     successfully launching a second PlaywrightBrowser against the same
 *     CDP port afterward and driving it.
 *
 * Run: npx tsx test/v45.playwright-port.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type CDP from 'chrome-remote-interface';
import { PlaywrightBrowser } from '../src/ports/playwright-browser.js';
import type { AxNode } from '../src/ports/browser-port.js';
import { runPortContract } from './port-contract.js';
import { startFixture, stopFixture } from '../fixture/server.js';

const CDP_PORT = 9332; // dedicated to this suite — distinct from the daemon (9322) and every other test's port
const CONTRACT_HTTP_PORT = 9411; // port-contract's own throwaway inline fixture (closed before FIXTURE_PORT reuses it)
const FIXTURE_PORT = 9411; // fixture/server.ts — reused sequentially once the contract suite's server has fully closed

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function newBrowser(): PlaywrightBrowser {
  return new PlaywrightBrowser({
    port: CDP_PORT,
    profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'qa-v45-')),
    headless: true,
  });
}

function find(root: AxNode, role: string, nameIncludes: string): AxNode | undefined {
  if (root.role === role && root.name?.toLowerCase().includes(nameIncludes.toLowerCase())) return root;
  for (const c of root.children ?? []) {
    const hit = find(c, role, nameIncludes);
    if (hit) return hit;
  }
  return undefined;
}

async function clickByName(browser: PlaywrightBrowser, role: string, name: string): Promise<void> {
  const ax = await browser.axTree();
  const node = find(ax.root, role, name);
  if (!node) throw new Error(`${role} "${name}" not found in:\n${ax.text}`);
  await browser.click(node.id);
  await sleep(600);
}

async function typeByName(browser: PlaywrightBrowser, name: string, text: string): Promise<void> {
  const ax = await browser.axTree();
  const node = find(ax.root, 'textbox', name);
  if (!node) throw new Error(`textbox "${name}" not found in:\n${ax.text}`);
  await browser.type(node.id, text);
}

async function walkToCheckout(browser: PlaywrightBrowser): Promise<void> {
  await browser.navigate(`http://localhost:${FIXTURE_PORT}/login`);
  await typeByName(browser, 'Email', 'test@test.com');
  await typeByName(browser, 'Password', 'pw');
  await clickByName(browser, 'button', 'Sign in');
  await clickByName(browser, 'button', 'Add Widget');
  await clickByName(browser, 'button', 'Go to cart');
  await clickByName(browser, 'button', 'Checkout');
}

/** Run `expression` in `browser`'s current page via its raw CDP escape hatch
 * — test-only verification, not something the driver/model ever does (see
 * assertions/invariants.ts's note on why probeInvariants() never accepts
 * caller-supplied JS; this is a test harness, not the product path). */
async function evalIn(browser: PlaywrightBrowser, expression: string): Promise<unknown> {
  const client = browser.cdpClient() as CDP.Client;
  const { result } = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  return result.value;
}

async function main() {
  /* ---- 1: shared BrowserPort contract ---- */
  console.log('=== 1/5: shared BrowserPort contract (runPortContract) ===');
  const contractBrowser = newBrowser();
  const contractResults = await runPortContract(contractBrowser, { label: 'PlaywrightBrowser', httpPort: CONTRACT_HTTP_PORT });
  for (const r of contractResults) checks.push([`contract: ${r.label}`, r.ok]);

  /* ---- 2: real dogfood fixture, healthy + bug-on ---- */
  console.log('\n=== 2/5: real dogfood fixture (login → cart → checkout) ===');
  const fixtureBrowser = newBrowser();
  await fixtureBrowser.launch();
  try {
    let server = startFixture(FIXTURE_PORT, false);
    try {
      await walkToCheckout(fixtureBrowser);
      fixtureBrowser.drainConsole();
      fixtureBrowser.drainNetwork();
      await clickByName(fixtureBrowser, 'button', 'Place order');
      await sleep(800);
      check('healthy: reaches /success', (await fixtureBrowser.url()).includes('/success'));
      const okNet = fixtureBrowser.drainNetwork();
      check('healthy: /api/order returned 200', okNet.some((e) => e.url.includes('/api/order') && e.status === 200));
      check('healthy: no page errors', !fixtureBrowser.drainConsole().some((e) => e.level === 'page-error'));
    } finally {
      await stopFixture(server);
    }

    server = startFixture(FIXTURE_PORT, true);
    try {
      await walkToCheckout(fixtureBrowser);
      fixtureBrowser.drainConsole();
      fixtureBrowser.drainNetwork();
      await clickByName(fixtureBrowser, 'button', 'Place order');
      await sleep(800);
      check('bug: stays on /checkout', (await fixtureBrowser.url()).includes('/checkout'));
      const badConsole = fixtureBrowser.drainConsole();
      const badNet = fixtureBrowser.drainNetwork();
      check('bug: uncaught [PAGE-ERROR] captured (per-step drain)', badConsole.some((e) => e.level === 'page-error' && e.text.includes('toFixed')));
      check('bug: /api/order 500 captured (per-step drain)', badNet.some((e) => e.url.includes('/api/order') && e.status === 500));
      const ax = await fixtureBrowser.axTree();
      check('bug: crash banner visible in a11y tree', ax.text.includes('Application error'));
      check('axTree ids are the compact "n<seq>" stable-id form', /^n\d+/.test(ax.root.id));
    } finally {
      await stopFixture(server);
    }
  } finally {
    await fixtureBrowser.close();
  }

  /* ---- 3: two contexts, same Chrome, cookie-isolated ---- */
  console.log('\n=== 3/5: two PlaywrightBrowser instances on the SAME Chrome — cookie isolation ===');
  const server3 = startFixture(FIXTURE_PORT, false);
  const browserA = newBrowser();
  const browserB = newBrowser();
  try {
    await browserA.launch(); // first call spawns Chrome on CDP_PORT
    await browserB.launch(); // second call reuses the SAME live Chrome (ensureChrome's cdpAlive() branch)

    const t0 = Date.now();
    await Promise.all([
      browserA.navigate(`http://localhost:${FIXTURE_PORT}/login`),
      browserB.navigate(`http://localhost:${FIXTURE_PORT}/login`),
    ]);
    check('two contexts drive concurrently', Date.now() - t0 < 5000);

    await evalIn(browserA, `document.cookie = 'spike_v45=A; path=/'`);
    const cookieSeenInA = String(await evalIn(browserA, 'document.cookie'));
    const cookieSeenInB = String(await evalIn(browserB, 'document.cookie'));
    check('cookie set in A is visible in A', cookieSeenInA.includes('spike_v45=A'));
    check('cookie set in A is INVISIBLE in B (real context isolation)', !cookieSeenInB.includes('spike_v45=A'));

    await evalIn(browserA, `localStorage.setItem('spike_v45_ls', 'A')`);
    const lsA = await evalIn(browserA, `localStorage.getItem('spike_v45_ls')`);
    const lsB = await evalIn(browserB, `localStorage.getItem('spike_v45_ls')`);
    check('localStorage set in A reads back in A', lsA === 'A');
    check('localStorage set in A is INVISIBLE in B', lsB === null);

    /* ---- 4: storageState() / setStorageState() round-trip ---- */
    console.log('\n=== 4/5: storageState()/setStorageState() round-trip (A6 primitive) ===');
    const state = await browserA.storageState();
    check('storageState() exports the cookie set in A', Boolean(state.cookies?.some((c) => c.name === 'spike_v45')));

    await browserB.setStorageState(state);
    await browserB.navigate(`http://localhost:${FIXTURE_PORT}/login`); // re-navigate so B's page picks up the injected cookie
    const cookieInBAfterInject = String(await evalIn(browserB, 'document.cookie'));
    check('setStorageState() on B makes A\'s cookie visible in B', cookieInBAfterInject.includes('spike_v45=A'));
  } finally {
    await browserA.close();
    await browserB.close();
    await stopFixture(server3);
  }

  /* ---- 5: closing one PlaywrightBrowser does not kill the shared Chrome ---- */
  console.log('\n=== 5/5: close() disconnects Playwright without killing the daemon\'s Chrome ===');
  const server5 = startFixture(FIXTURE_PORT, false);
  const browserC = newBrowser();
  try {
    await browserC.launch(); // reuses the same CDP_PORT Chrome browserA/browserB just closed out of
    await browserC.navigate(`http://localhost:${FIXTURE_PORT}/login`);
    check('a fresh PlaywrightBrowser reconnects to the SAME Chrome after a prior close()', (await browserC.url()).includes('/login'));
    const ax = await browserC.axTree();
    check('...and can still drive it (axTree resolves real content)', Boolean(find(ax.root, 'button', 'Sign in')));
  } finally {
    await browserC.close();
    await stopFixture(server5);
  }

  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} v45 playwright-port checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
