/* v24 — multi-client bridge multiplexing (the money proof).
 *
 * Today's bug: BridgeServer kept ONE socket (newest wins), so two Chromes both
 * running the extension fought over the daemon — a tab created via Chrome A then
 * driven via Chrome B errored "No tab with id". This test proves the fix:
 *
 *   - TWO headless Chromes, both with the QA extension, both PINNED to the same
 *     private bridge port 9428 (launchChromeWithExtension bridgePorts). CDP ports
 *     9348 and 9349 keep the two Chromes apart.
 *   - bridge.clientIds() reaches length 2 → both SWs joined as distinct clients.
 *   - create a tab via client A, then ext.url on that tab:
 *       · via client A → succeeds (the tab lives in A's Chrome)
 *       · via client B → fails "No tab with id" (isolation is real, routing matters)
 *   - new ExtensionBrowser({ bridge, clientId: A }) navigates A to a tiny http
 *     page on 9429 and axTree works — all its bridge traffic is pinned to A.
 *     Client B's Chrome stays untouched throughout.
 *   - close A's Chrome → bridge cleans A's pending; a call targeted at A rejects
 *     'client disconnected' / 'no such client'.
 *
 * Both Chromes are killed in finally.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { launchChromeWithExtension } from '../src/chrome/extensions.js';
import { BridgeServer } from '../src/bridge/bridge-server.js';
import { ExtensionBrowser } from '../src/ports/extension-browser.js';

const BRIDGE_PORT = 9428;
const CDP_A = 9348;
const CDP_B = 9349;
const HTTP_PORT = 9429;
const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const PAGE = '<!doctype html><html><head><title>v24</title></head><body><h1>multiplex ok</h1><button>Go</button></body></html>';
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGE);
});

const bridge = new BridgeServer(BRIDGE_PORT);
let chromeA: Awaited<ReturnType<typeof launchChromeWithExtension>>['chrome'] | null = null;
let chromeB: Awaited<ReturnType<typeof launchChromeWithExtension>>['chrome'] | null = null;

try {
  await new Promise<void>((resolve) => server.listen(HTTP_PORT, resolve));

  // Launch both Chromes, each with the extension, both pinned to BRIDGE_PORT.
  const launchedA = await launchChromeWithExtension({
    cdpPort: CDP_A,
    extensionDir: EXT_DIR,
    profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'qa-v24a-')),
    headless: true,
    bridgePorts: [BRIDGE_PORT],
  });
  chromeA = launchedA.chrome;
  const launchedB = await launchChromeWithExtension({
    cdpPort: CDP_B,
    extensionDir: EXT_DIR,
    profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'qa-v24b-')),
    headless: true,
    bridgePorts: [BRIDGE_PORT],
  });
  chromeB = launchedB.chrome;

  // Wait until BOTH SWs have joined as distinct clients.
  const deadline = Date.now() + 30_000;
  while (bridge.clientIds().length < 2 && Date.now() < deadline) await sleep(250);
  check('two extension clients connected to one bridge', bridge.clientIds().length === 2);

  const ids = bridge.clientIds();
  const [clientA, clientB] = ids;
  console.log(`client ids: A=${clientA} B=${clientB}`);

  // Create a tab via client A.
  const { tabId } = await bridge.call<{ tabId: number }>(
    'ext.createTab',
    { url: 'about:blank' },
    20_000,
    { clientId: clientA },
  );
  check('client A created a tab', typeof tabId === 'number');

  // ext.url on that tab via client A → succeeds.
  let urlViaA = '';
  try {
    const r = await bridge.call<{ url: string }>('ext.url', { tabId }, 10_000, { clientId: clientA });
    urlViaA = r.url;
    check('ext.url on the tab via client A succeeds', true);
  } catch (e) {
    check('ext.url on the tab via client A succeeds', false);
    console.log('  unexpected:', e instanceof Error ? e.message : e);
  }

  // ext.url on that SAME tabId via client B → fails 'No tab with id' (isolation).
  let bRejected = false;
  let bMsg = '';
  try {
    await bridge.call<{ url: string }>('ext.url', { tabId }, 10_000, { clientId: clientB });
  } catch (e) {
    bRejected = true;
    bMsg = e instanceof Error ? e.message : String(e);
  }
  check('ext.url on A\'s tab via client B fails (No tab with id)', bRejected && /no tab with id/i.test(bMsg));
  if (bRejected) console.log('  client B error (expected):', bMsg);

  // Bind an ExtensionBrowser to client A, navigate it to the http page, axTree.
  const browserA = new ExtensionBrowser({ bridge, clientId: clientA });
  await browserA.launch();
  await browserA.navigate(`http://localhost:${HTTP_PORT}/`);
  const url = await browserA.url();
  check('ExtensionBrowser(clientId:A) navigated A', url.includes(`localhost:${HTTP_PORT}`));
  const ax = await browserA.axTree();
  check('axTree works over the client-A-bound browser', ax.text.length > 0 && /multiplex ok|Go/i.test(ax.text));

  // Client B's Chrome stayed untouched: it still has exactly its own clientId,
  // both clients still present (nothing stole B's socket).
  check('both clients still connected (B untouched)', bridge.clientIds().length === 2);

  await browserA.close();

  // Close A's Chrome → bridge drops client A, rejecting its pending and removing it.
  try { chromeA.kill(); } catch { /* gone */ }
  chromeA = null;
  const goneBy = Date.now() + 15_000;
  while (bridge.clientIds().includes(clientA) && Date.now() < goneBy) await sleep(250);
  check('client A removed after its Chrome closed', !bridge.clientIds().includes(clientA));

  // A call targeted at the now-gone client A rejects.
  let aGoneRejected = false;
  let aGoneMsg = '';
  try {
    await bridge.call('ext.url', { tabId }, 5_000, { clientId: clientA });
  } catch (e) {
    aGoneRejected = true;
    aGoneMsg = e instanceof Error ? e.message : String(e);
  }
  check(
    'call targeted at disconnected client A rejects',
    aGoneRejected && /client disconnected|no such client/i.test(aGoneMsg),
  );
  if (aGoneRejected) console.log('  client A gone error (expected):', aGoneMsg);

  void urlViaA;
} catch (e) {
  console.error('V24 FAILED:', e instanceof Error ? e.stack ?? e.message : e);
  checks.push(['unexpected throw', false]);
} finally {
  await bridge.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (chromeA) { try { chromeA.kill(); } catch { /* gone */ } }
  if (chromeB) { try { chromeB.kill(); } catch { /* gone */ } }
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v24 checks passed`);
process.exit(failed.length ? 1 : 0);
