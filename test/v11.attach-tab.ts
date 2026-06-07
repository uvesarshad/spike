/* V11 — attach-to-existing-tab verification (no AI, scripted).
 *
 * Proves the vibe-mode "target the user's CURRENT tab" path end to end:
 *   - launchChromeWithExtension dev-loads the real MV3 SW (CDP 9331, headless).
 *   - A BridgeServer accepts the SW's dial-out; we then build
 *     `new ExtensionBrowser({ bridge, attachTabId: tabId })` against an EXISTING
 *     tab (NOT create), navigate /login, drive it through the BrowserPort
 *     interface, assert type() REPLACES (second string wins), close() — and assert
 *     the tab STILL EXISTS afterward (only the debugger detached).
 *
 * Bridge isolation on THIS machine: the QA extension is ALSO installed in the
 * user's real Chrome (same stable extension ID, OLD sw.js). Both service workers
 * round-robin the bridge candidate ports (9410-9413) and BridgeServer keeps the
 * latest socket — so a stale real-Chrome SW (no ext.attachTab) would supersede
 * ours and break the run. To pin the bridge to OUR launched Chrome's SW we put a
 * tiny gatekeeper WS proxy on the mandated port 9412: it reads each connector's
 * `hello.caps` and only pipes the NEW-code SW (caps incl. 'ext.attachTab') through
 * to the real BridgeServer (on a private port 9499 the SW never dials); stale
 * connections are dropped. The product needs no gatekeeper — there is exactly one
 * Chrome there. (Never binds 9410.)
 *
 * Isolated ports: CDP 9331, public bridge 9412, private bridge 9499, fixture from
 * loadConfig. We OWN and kill the spawned Chrome in finally. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import CDP from 'chrome-remote-interface';
import { launchChromeWithExtension } from '../src/chrome/extensions.js';
import { BridgeServer } from '../src/bridge/bridge-server.js';
import { ExtensionBrowser } from '../src/ports/extension-browser.js';
import { loadConfig } from '../src/config.js';
import { sleep } from '../src/chrome/launch.js';
import type { AxNode } from '../src/ports/browser-port.js';
import { startFixture, stopFixture } from '../fixture/server.js';

const CDP_PORT = 9331;
const PUBLIC_BRIDGE_PORT = 9412; // what the SW dials (mandated)
const PRIVATE_BRIDGE_PORT = 9499; // real BridgeServer, outside the SW candidate range
const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const cfg = loadConfig();
const FIXTURE = `http://localhost:${cfg.fixturePort}`;

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

/* Gatekeeper: accept SW dial-outs on PUBLIC_BRIDGE_PORT, peek the first frame
 * (the `hello`), and ONLY pipe a NEW-code SW (caps includes 'ext.attachTab')
 * through to the real BridgeServer on PRIVATE_BRIDGE_PORT. Stale SWs are closed.
 * Once one SW is selected, further connectors are rejected so it can't be
 * superseded mid-run. */
function startGatekeeper(): { close(): Promise<void> } {
  const wss = new WebSocketServer({ port: PUBLIC_BRIDGE_PORT });
  let selected: WebSocket | null = null;
  let upstream: WebSocket | null = null;

  wss.on('connection', (sw) => {
    let decided = false;
    sw.on('message', (data) => {
      const raw = data.toString();
      if (!decided) {
        let hello: { event?: string; params?: { caps?: string[] } } | undefined;
        try { hello = JSON.parse(raw); } catch { /* */ }
        const caps = hello?.event === 'hello' ? hello.params?.caps : undefined;
        const isNew = Array.isArray(caps) && caps.includes('ext.attachTab');
        if (selected || !isNew) { try { sw.close(); } catch { /* */ } return; }
        decided = true;
        selected = sw;
        // Open the upstream link to the real BridgeServer and pipe both ways.
        upstream = new WebSocket(`ws://localhost:${PRIVATE_BRIDGE_PORT}/`);
        const queue: string[] = [raw]; // forward the hello once upstream opens
        upstream.on('open', () => { for (const m of queue) upstream!.send(m); queue.length = 0; });
        upstream.on('message', (d) => { try { sw.send(d.toString()); } catch { /* */ } });
        upstream.on('close', () => { try { sw.close(); } catch { /* */ } });
        upstream.on('error', () => { try { sw.close(); } catch { /* */ } });
        sw.on('close', () => { try { upstream?.close(); } catch { /* */ } selected = null; });
        return;
      }
      // steady state: SW → upstream
      if (upstream && upstream.readyState === WebSocket.OPEN) upstream.send(raw);
    });
    sw.on('error', () => { try { sw.close(); } catch { /* */ } });
  });

  return {
    async close() {
      try { upstream?.close(); } catch { /* */ }
      try { selected?.close(); } catch { /* */ }
      await new Promise<void>((r) => wss.close(() => r()));
    },
  };
}

const fixture = startFixture(cfg.fixturePort, false); // healthy fixture
const bridge = new BridgeServer(PRIVATE_BRIDGE_PORT); // real bridge, gated
const gate = startGatekeeper();

let chrome: Awaited<ReturnType<typeof launchChromeWithExtension>>['chrome'] | null = null;
let swClient: CDP.Client | null = null;

try {
  const launched = await launchChromeWithExtension({
    cdpPort: CDP_PORT,
    extensionDir: EXT_DIR,
    profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'qa-v11-')),
    headless: true,
  });
  chrome = launched.chrome;
  // Wait for OUR new-code SW to be piped through the gatekeeper to the bridge.
  await bridge.waitForExtension(40_000);
  check('our new-code extension SW reached the bridge (gated)', true);

  // Attach to the SW target so we can drive chrome.tabs from OUR launched Chrome.
  const targets = await CDP.List({ port: CDP_PORT });
  const sw = targets.find((t) => t.url === `chrome-extension://${launched.extensionId}/sw.js`);
  if (!sw) throw new Error('SW target not found');
  swClient = await CDP({ port: CDP_PORT, target: sw.id });
  await swClient.Runtime.enable();
  const swEval = async <T>(expression: string): Promise<T> => {
    const { result, exceptionDetails } = await swClient!.Runtime.evaluate({
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'sw eval failed');
    return result.value as T;
  };

  // The user's CURRENT tab: create one in OUR Chrome (stands in for the tab the
  // side panel is open on) and grab its tabId — exactly what the panel sends.
  const tabId = await swEval<number>(
    `new Promise((res, rej) => chrome.tabs.create({ url: ${JSON.stringify(FIXTURE + '/products')}, active: true }, (t) => chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(t.id)))`,
  );
  check('created a user tab to attach to', typeof tabId === 'number');

  // Daemon-side: ATTACH to that existing tab (must NOT create a new one).
  const browser = new ExtensionBrowser({ bridge, attachTabId: tabId });
  await browser.launch();
  check('ExtensionBrowser.launch attached to the existing tab', true);

  await browser.navigate(`${FIXTURE}/login`);
  await sleep(200);
  check('navigate → on /login', (await browser.url()).includes('/login'));

  const ax = await browser.axTree();
  const signin = find(ax.root, 'button', 'Sign in');
  check('axTree finds the Sign in button', Boolean(signin));

  // type() must REPLACE: type twice into Email, the second value wins.
  const email = find(ax.root, 'textbox', 'Email');
  if (!email) throw new Error('Email textbox not found');
  await browser.type(email.id, 'first@first.com');
  await browser.type(email.id, 'second@second.com');
  const ax2 = await browser.axTree();
  const email2 = find(ax2.root, 'textbox', 'Email');
  check('type() REPLACES (fresh axTree value == second string)', email2?.value === 'second@second.com');

  await browser.close();
  check('ExtensionBrowser.close returned', true);

  // The attached tab must STILL EXIST after close() (only the debugger detached).
  const stillExists = await swEval<boolean>(
    `new Promise((res) => chrome.tabs.get(${tabId}, (t) => res(!chrome.runtime.lastError && !!t)))`,
  );
  check('attached tab still exists after close() (not removed)', stillExists === true);
} catch (e) {
  console.error('V11 FAILED:', e instanceof Error ? (e.stack ?? e.message) : e);
  check('ran without throwing', false);
} finally {
  if (swClient) { try { await swClient.close(); } catch { /* gone */ } }
  await bridge.close();
  await gate.close();
  await stopFixture(fixture);
  if (chrome) {
    try { chrome.kill(); } catch { /* gone */ }
  }
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v11 checks passed`);
process.exit(failed.length ? 1 : 0);
