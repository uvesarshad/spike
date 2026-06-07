/* ExtensionBrowser — the BrowserPort implemented over an MV3 extension
 * (chrome.debugger), reached through the daemon↔extension WebSocket bridge.
 * This is what makes the product plug-and-play (Web Store install, no flags,
 * real logged-in sessions, native Prompt API access).
 *
 * Design: the bridge gives us two layers —
 *   1. ext.* lifecycle methods (createTab/navigate/url/closeTab) implemented in
 *      the service worker with chrome.tabs + chrome.debugger.attach.
 *   2. a `cdp` passthrough to chrome.debugger.sendCommand, wrapped by a Proxy
 *      shim (createCdpShim) so the EXACT same capture/executor helpers used by
 *      CdpBrowser (snapshotAxTree, attachCapture, setLogpointByContent) run
 *      unchanged. The engine never knows which transport it got.
 */

import { sleep } from '../chrome/launch.js';
import { attachCapture, type CaptureBuffers } from '../capture/console-network.js';
import { setLogpointByContent } from '../capture/logpoints.js';
import { snapshotAxTree } from '../capture/axtree.js';
import { BridgeServer, DEFAULT_BRIDGE_PORT } from '../bridge/bridge-server.js';
import { createCdpShim, type CdpShim } from '../bridge/cdp-shim.js';
import type {
  AxNode,
  AxSnapshot,
  BrowserPort,
  ConsoleEntry,
  LogpointSpec,
  NetworkEntry,
} from './browser-port.js';

export interface ExtensionBrowserOptions {
  /** A running BridgeServer, or a port to stand one up on (default 9410). */
  bridge?: BridgeServer;
  bridgePort?: number;
  /** Page Chrome opens on tab create; about:blank is fine for the harness. */
  initialUrl?: string;
  /** How long launch() waits for the extension SW to connect in. */
  connectTimeoutMs?: number;
}

export class ExtensionBrowser implements BrowserPort {
  private bridge: BridgeServer | null = null;
  /** True when this instance created (and therefore owns/closes) the bridge. */
  private ownsBridge = false;
  private shim: CdpShim | null = null;
  private tabId: number | null = null;
  private capture: CaptureBuffers | null = null;
  /** planner nodeId ("n7") → backendDOMNodeId; refreshed by every axTree(). */
  private nodeMap = new Map<string, number>();
  /** Last a11y snapshot — read by nodeLabel() for ghost-cursor captions. */
  private lastSnapshot: AxSnapshot | null = null;

  constructor(private readonly opts: ExtensionBrowserOptions = {}) {}

  private get b(): BridgeServer {
    if (!this.bridge) throw new Error('ExtensionBrowser: launch() first');
    return this.bridge;
  }

  private get c() {
    if (!this.shim) throw new Error('ExtensionBrowser: launch() first');
    return this.shim.client;
  }

  private get tab(): number {
    if (this.tabId === null) throw new Error('ExtensionBrowser: launch() first');
    return this.tabId;
  }

  async launch(): Promise<void> {
    if (this.shim) return;

    if (this.opts.bridge) {
      this.bridge = this.opts.bridge;
      this.ownsBridge = false;
    } else {
      this.bridge = new BridgeServer(this.opts.bridgePort ?? DEFAULT_BRIDGE_PORT);
      this.ownsBridge = true;
    }

    await this.bridge.waitForExtension(this.opts.connectTimeoutMs ?? 30_000);

    // SW creates the tab and attaches chrome.debugger (version 1.3) to it.
    const { tabId } = await this.b.call<{ tabId: number }>('ext.createTab', {
      url: this.opts.initialUrl ?? 'about:blank',
    });
    this.tabId = tabId;

    // Build the CDP shim bound to this tab; enable the same domains CdpBrowser does.
    this.shim = createCdpShim(this.b, tabId);
    await Promise.all([
      this.c.Page.enable(),
      this.c.Runtime.enable(),
      this.c.Debugger.enable(),
      this.c.DOM.enable(),
      this.c.Accessibility.enable(),
    ]);
    // capture must attach before the first navigation so nothing is missed
    this.capture = await attachCapture(this.c);
  }

  async navigate(url: string): Promise<void> {
    this.emitCursor({ kind: 'caption', caption: 'Opening ' + url });
    // The SW resolves on chrome.tabs.onUpdated status 'complete' for this tab.
    await this.b.call('ext.navigate', { tabId: this.tab, url }, 30_000);
    await sleep(300); // let first paint + late console output settle
  }

  async url(): Promise<string> {
    const { url } = await this.b.call<{ url: string }>('ext.url', { tabId: this.tab });
    return url;
  }

  async axTree(): Promise<AxSnapshot> {
    const { snapshot, nodeMap } = await snapshotAxTree(this.c);
    this.nodeMap = nodeMap;
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  /** Human-readable label for a nodeId, e.g. `the "Sign in" button`. */
  private nodeLabel(nodeId: string): string {
    const find = (node: AxNode | undefined): AxNode | undefined => {
      if (!node) return undefined;
      if (node.id === nodeId) return node;
      for (const child of node.children ?? []) {
        const hit = find(child);
        if (hit) return hit;
      }
      return undefined;
    };
    const node = find(this.lastSnapshot?.root);
    if (!node) return 'an element';
    const role = node.role || 'element';
    if (node.name) return `the ${JSON.stringify(node.name)} ${role}`;
    return `a ${role}`;
  }

  /** Fire a vibe.cursor event; never let UI fan-out fail the action. */
  private emitCursor(params: Record<string, unknown>): void {
    try {
      this.b.sendEvent('vibe.cursor', { tabId: this.tab, ...params });
    } catch {
      /* fire-and-forget — overlay is cosmetic */
    }
  }

  private backendNodeId(nodeId: string): number {
    const backendId = this.nodeMap.get(nodeId);
    if (backendId === undefined) {
      throw new Error(`unknown nodeId ${nodeId} — stale snapshot? (re-run axTree)`);
    }
    return backendId;
  }

  async click(nodeId: string): Promise<void> {
    const backendNodeId = this.backendNodeId(nodeId);
    // chrome.debugger-dispatched input is silently dropped on a backgrounded
    // tab (unlike raw CDP) — e.g. when the Nano runner tab opened after us.
    // Foregrounding is also what the "watch the robot" UX wants.
    await this.c.Page.bringToFront().catch(() => {});
    await this.c.DOM.scrollIntoViewIfNeeded({ backendNodeId }).catch(() => {});
    const { model } = await this.c.DOM.getBoxModel({ backendNodeId });
    const quad = model.content;
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    // Ghost cursor: glide to the target + caption BEFORE dispatching, so the
    // viewer sees the cursor arrive; the sleep gives the CSS transition time.
    this.emitCursor({ kind: 'move', x, y, caption: 'Clicking ' + this.nodeLabel(nodeId) });
    await sleep(350);
    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await this.c.Input.dispatchMouseEvent({ type, x, y, button: 'left', clickCount: 1 });
    }
    this.emitCursor({ kind: 'click', x, y }); // ripple at the click point
    await sleep(400); // allow handlers/navigation to kick off
  }

  async type(nodeId: string, text: string): Promise<void> {
    const backendNodeId = this.backendNodeId(nodeId);
    await this.c.Page.bringToFront().catch(() => {}); // see click()
    await this.c.DOM.scrollIntoViewIfNeeded({ backendNodeId }).catch(() => {});
    // Ghost cursor: move to the field + caption before inserting the text.
    try {
      const { model } = await this.c.DOM.getBoxModel({ backendNodeId });
      const quad = model.content;
      const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
      const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
      this.emitCursor({ kind: 'type', x, y, caption: 'Typing into ' + this.nodeLabel(nodeId) });
      await sleep(350);
    } catch {
      // box model can fail (off-screen/detached) — caption-only fallback
      this.emitCursor({ kind: 'caption', caption: 'Typing into ' + this.nodeLabel(nodeId) });
    }
    await this.c.DOM.focus({ backendNodeId });
    await this.c.Input.insertText({ text });
    await sleep(150);
  }

  async screenshot(): Promise<Buffer> {
    const { data } = await this.c.Page.captureScreenshot({ format: 'png' });
    return Buffer.from(data, 'base64');
  }

  async setLogpoint(spec: LogpointSpec): Promise<void> {
    await setLogpointByContent(this.c, spec);
  }

  drainConsole(): ConsoleEntry[] {
    return this.capture?.drainConsole() ?? [];
  }

  drainNetwork(): NetworkEntry[] {
    return this.capture?.drainNetwork() ?? [];
  }

  async close(): Promise<void> {
    if (this.tabId !== null && this.bridge) {
      try { await this.b.call('ext.closeTab', { tabId: this.tabId }, 5_000); } catch { /* tab/SW gone */ }
    }
    this.shim?.dispose();
    this.shim = null;
    this.tabId = null;
    this.capture = null;
    this.nodeMap.clear();
    if (this.ownsBridge && this.bridge) {
      try { await this.bridge.close(); } catch { /* already closed */ }
    }
    this.bridge = null;
    this.ownsBridge = false;
  }
}
