/* V5 — no-AI verification that extension-mode session wiring (config → engine)
 * works end to end WITHOUT touching the Nano profile or the forbidden default
 * ports.
 *
 * It exercises the engine's openBrowserSession({ via:'extension' }) helper: the
 * engine stands up a BridgeServer on cfg.bridgePort, spawns a Chrome with the QA
 * extension dev-loaded on a throwaway profile/CDP port, builds an ExtensionBrowser
 * over the bridge, and we then drive the healthy fixture purely through the
 * BrowserPort interface (navigate → axTree → screenshot). Nano is NOT involved.
 *
 * Why a mock service worker (swShim): extension/sw.js HARD-CODES its bridge dial-out
 * to ws://localhost:9410/, and both sw.js and the default port 9410 are off-limits
 * for this task. So the real SW cannot reach our isolated bridge on 9412. The shim
 * stands in for the SW on 9412 — it speaks the exact bridge wire protocol
 * (ext.createTab/navigate/url/closeTab + the `cdp` passthrough + forwarded `cdp`
 * events) by proxying to the SAME spawned Chrome over its CDP port. This drives the
 * REAL ExtensionBrowser + BridgeServer + engine wiring; only the SW transport is
 * mocked. (When the parallel work makes sw.js port-configurable, the shim can be
 * dropped and BRIDGE_PORT pointed at the real SW.)
 *
 * Isolated ports: CDP 9328, bridge 9412, fixture from loadConfig (9401). Defaults
 * (CDP 9322 / bridge 9410) are never bound here. We OWN and kill the spawned Chrome
 * at the end via session.chromeProcess — the test, unlike the product, must not
 * leak a warm Chrome. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import CDP from 'chrome-remote-interface';
import { loadConfig } from '../src/config.js';
import { openBrowserSession } from '../src/engine.js';
import type { AxNode } from '../src/ports/browser-port.js';
import { startFixture, stopFixture } from '../fixture/server.js';

const CDP_PORT = 9328;
const BRIDGE_PORT = 9412;

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

/* ---- mock service worker: bridge-protocol shim backed by real CDP ----------
 * Connects out to ws://localhost:<bridgePort>/ (like the real SW would) and
 * answers daemon requests by driving the spawned Chrome over its CDP port. */
function startSwShim(bridgePort: number, cdpPort: number): { close(): Promise<void> } {
  let ws: WebSocket | null = null;
  let closed = false;
  // tabId (CDP target id is a string; we map it to a small numeric id) → CDP client
  const clients = new Map<number, CDP.Client>();
  const targetIds = new Map<number, string>();
  let nextTabId = 1;

  const send = (obj: unknown) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  const handle = async (msg: { id: number; method: string; params?: Record<string, unknown> }) => {
    const { id, method, params = {} } = msg;
    try {
      let result: unknown;
      switch (method) {
        case 'ext.createTab': {
          const target = await CDP.New({ port: cdpPort, url: String(params.url ?? 'about:blank') });
          const targetId =
            (target as { id?: string; targetId?: string }).id ??
            (target as { targetId?: string }).targetId!;
          const client = await CDP({ port: cdpPort, target: targetId });
          const tabId = nextTabId++;
          clients.set(tabId, client);
          targetIds.set(tabId, targetId);
          // forward every CDP event for this tab back to the daemon as a bridge `cdp` event
          (client as unknown as { on(name: string, fn: (m: { method: string; params: unknown }) => void): void }).on(
            'event',
            (m) => send({ event: 'cdp', params: { tabId, method: m.method, params: m.params ?? {} } }),
          );
          result = { tabId };
          break;
        }
        case 'ext.navigate': {
          const client = clients.get(Number(params.tabId))!;
          await client.Page.navigate({ url: String(params.url) });
          await client.Page.loadEventFired().catch(() => {});
          result = { ok: true };
          break;
        }
        case 'ext.url': {
          const client = clients.get(Number(params.tabId))!;
          const { result: r } = await client.Runtime.evaluate({ expression: 'location.href', returnByValue: true });
          result = { url: (r.value as string) ?? '' };
          break;
        }
        case 'ext.closeTab': {
          const tabId = Number(params.tabId);
          const client = clients.get(tabId);
          const targetId = targetIds.get(tabId);
          if (client) { try { await client.close(); } catch { /* gone */ } }
          if (targetId) { try { await CDP.Close({ port: cdpPort, id: targetId }); } catch { /* gone */ } }
          clients.delete(tabId);
          targetIds.delete(tabId);
          result = { ok: true };
          break;
        }
        case 'cdp': {
          const client = clients.get(Number(params.tabId))!;
          const rawSend = (client as unknown as {
            send(method: string, params?: Record<string, unknown>): Promise<unknown>;
          }).send.bind(client);
          result = await rawSend(params.method as string, (params.params as Record<string, unknown>) ?? {});
          break;
        }
        default:
          throw new Error(`shim: unknown method ${method}`);
      }
      send({ id, result });
    } catch (err) {
      send({ id, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const connect = () => {
    if (closed) return;
    ws = new WebSocket(`ws://localhost:${bridgePort}/`);
    ws.on('message', (data) => {
      let msg: { id?: number; method?: string; params?: Record<string, unknown> };
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (typeof msg.id === 'number' && typeof msg.method === 'string') {
        void handle(msg as { id: number; method: string; params?: Record<string, unknown> });
      }
    });
    ws.on('close', () => { if (!closed) setTimeout(connect, 200); });
    ws.on('error', () => { try { ws?.close(); } catch { /* noop */ } });
  };
  connect();

  return {
    async close() {
      closed = true;
      for (const client of clients.values()) { try { await client.close(); } catch { /* gone */ } }
      clients.clear();
      if (ws) { try { ws.close(); } catch { /* gone */ } }
    },
  };
}

/* ---- test ------------------------------------------------------------------ */

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-v5-'));
const fixturePort = loadConfig().fixturePort; // 9401
const server = startFixture(fixturePort, false);

// stand up the mock SW BEFORE the engine builds the bridge; it reconnects until the
// BridgeServer (created inside openBrowserSession) is listening.
const shim = startSwShim(BRIDGE_PORT, CDP_PORT);

const session = await openBrowserSession({
  via: 'extension',
  cdpPort: CDP_PORT,
  bridgePort: BRIDGE_PORT,
  chromeProfile: profileDir,
});

try {
  check('openBrowserSession spawned a Chrome (extension mode, cold)', Boolean(session.chromeProcess));

  await session.browser.navigate(`http://localhost:${fixturePort}/login`);
  await sleep(200);
  check('navigate → on /login', (await session.browser.url()).includes('/login'));

  const ax = await session.browser.axTree();
  const signin = find(ax.root, 'button', 'Sign in');
  check('axTree contains the Sign in button', Boolean(signin));

  const png = await session.browser.screenshot();
  check('screenshot returns PNG', png.length > 1000 && png.subarray(1, 4).toString() === 'PNG');
} finally {
  await session.close();
  await shim.close();
  await stopFixture(server);
  // The product keeps Chrome warm; the test must not — kill the one we spawned.
  if (session.chromeProcess) {
    try { session.chromeProcess.kill(); } catch { /* already gone */ }
  }
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v5 checks passed`);
process.exit(failed.length ? 1 : 0);
