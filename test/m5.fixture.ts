/* Fixture sanity (fast, no model calls): scripted CdpBrowser walk through the
 * happy path (login → … → /success) and the bug path (crash banner +
 * [PAGE-ERROR] + 500 on /api/order, no navigation). Catches fixture breakage
 * without spending planner quota. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CdpBrowser } from '../src/ports/cdp-browser.js';
import type { AxNode } from '../src/ports/browser-port.js';
import { startFixture, stopFixture } from '../fixture/server.js';

const PORT = 9403;
const CDP_PORT = 9324; // throwaway headless

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

function find(root: AxNode, role: string, nameIncludes: string): AxNode | undefined {
  if (root.role === role && root.name?.toLowerCase().includes(nameIncludes.toLowerCase())) return root;
  for (const c of root.children ?? []) {
    const hit = find(c, role, nameIncludes);
    if (hit) return hit;
  }
  return undefined;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function clickByName(browser: CdpBrowser, role: string, name: string): Promise<void> {
  const ax = await browser.axTree();
  const node = find(ax.root, role, name);
  if (!node) throw new Error(`${role} "${name}" not found in:\n${ax.text}`);
  await browser.click(node.id);
  await sleep(600);
}

async function typeByName(browser: CdpBrowser, name: string, text: string): Promise<void> {
  const ax = await browser.axTree();
  const node = find(ax.root, 'textbox', name);
  if (!node) throw new Error(`textbox "${name}" not found in:\n${ax.text}`);
  await browser.type(node.id, text);
}

async function walkToCheckout(browser: CdpBrowser): Promise<void> {
  await browser.navigate(`http://localhost:${PORT}/login`);
  await typeByName(browser, 'Email', 'test@test.com');
  await typeByName(browser, 'Password', 'pw');
  await clickByName(browser, 'button', 'Sign in');
  await clickByName(browser, 'button', 'Add Widget');
  await clickByName(browser, 'button', 'Go to cart');
  await clickByName(browser, 'button', 'Checkout');
}

const browser = new CdpBrowser({
  port: CDP_PORT,
  profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'qa-m5-')),
  headless: true,
});
await browser.launch();

try {
  /* healthy */
  let server = startFixture(PORT, false);
  await walkToCheckout(browser);
  browser.drainConsole();
  browser.drainNetwork();
  await clickByName(browser, 'button', 'Place order');
  await sleep(800);
  check('healthy: reaches /success', (await browser.url()).includes('/success'));
  const okNet = browser.drainNetwork();
  check('healthy: /api/order returned 200', okNet.some((e) => e.url.includes('/api/order') && e.status === 200));
  check('healthy: no page errors', !browser.drainConsole().some((e) => e.level === 'page-error'));
  await stopFixture(server);

  /* bug on */
  server = startFixture(PORT, true);
  await walkToCheckout(browser);
  browser.drainConsole();
  browser.drainNetwork();
  await clickByName(browser, 'button', 'Place order');
  await sleep(800);
  check('bug: stays on /checkout', (await browser.url()).includes('/checkout'));
  const badConsole = browser.drainConsole();
  const badNet = browser.drainNetwork();
  // order.total is undefined → "Cannot read properties of undefined (reading 'toFixed')"
  check('bug: uncaught [PAGE-ERROR] captured', badConsole.some((e) => e.level === 'page-error' && e.text.includes('toFixed')));
  check('bug: /api/order 500 captured', badNet.some((e) => e.url.includes('/api/order') && e.status === 500));
  const ax = await browser.axTree();
  check('bug: crash banner visible in a11y tree', ax.text.includes('Application error'));
  await stopFixture(server);
} finally {
  await browser.close();
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} fixture checks passed`);
process.exit(failed.length ? 1 : 0);
