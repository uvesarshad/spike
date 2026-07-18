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

import crypto from 'node:crypto';
import { sleep } from '../chrome/launch.js';
import { attachCapture, type CaptureBuffers } from '../capture/console-network.js';
import { setLogpointByContent } from '../capture/logpoints.js';
import { snapshotAxTree } from '../capture/axtree.js';
import { BridgeServer, DEFAULT_BRIDGE_PORT } from '../bridge/bridge-server.js';
import { createCdpShim, type CdpShim } from '../bridge/cdp-shim.js';
import {
  assertMutationHostAllowed,
  hostOfUrl,
  type AxNode,
  type AxSnapshot,
  type BrowserPort,
  type ConsoleEntry,
  type LogpointSpec,
  type NetworkEntry,
} from './browser-port.js';

export interface ExtensionBrowserOptions {
  /** A running BridgeServer, or a port to stand one up on (default 9410). */
  bridge?: BridgeServer;
  bridgePort?: number;
  /** Page Chrome opens on tab create; about:blank is fine for the harness. */
  initialUrl?: string;
  /** How long launch() waits for the extension SW to connect in. */
  connectTimeoutMs?: number;
  /** When set, ATTACH to this existing tab (vibe mode targets the user's current
   * tab) instead of creating a fresh one — and close() leaves the tab open,
   * detaching only the debugger. Absent → current create/close behavior. */
  attachTabId?: number;
  /** When set, bind every bridge call/event this instance makes to a SPECIFIC
   * bridge client (one of several Chromes on a shared bridge). The cdp-shim
   * event subscription is filtered to it too. Absent → default-client behavior
   * (all current single-client tests unchanged). */
  clientId?: number;
  /** A4 (P0) defense-in-depth: hosts the driver may click/type on — re-checked
   * here independent of driver/loop.ts's own Tier-4 guard. Omitted → no
   * additional port-level restriction (see browser-port.ts's
   * DEFAULT_ALLOWED_HOSTS doc comment); pass the run's resolved allowedHosts
   * to actually enforce it here. */
  allowedHosts?: string[];
}

export class ExtensionBrowser implements BrowserPort {
  private bridge: BridgeServer | null = null;
  /** True when this instance created (and therefore owns/closes) the bridge. */
  private ownsBridge = false;
  private shim: CdpShim | null = null;
  private tabId: number | null = null;
  /** True when we ATTACHED to a pre-existing tab (attachTabId) — close() then
   * leaves that tab open and only detaches the debugger. */
  private attachedExisting = false;
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

  /** Targeted-client opts for bridge call/sendEvent, or undefined when this
   * instance is not pinned to a specific client (default-client behavior). */
  private get target(): { clientId: number } | undefined {
    return this.opts.clientId !== undefined ? { clientId: this.opts.clientId } : undefined;
  }

  private get c() {
    if (!this.shim) throw new Error('ExtensionBrowser: launch() first');
    return this.shim.client;
  }

  /** Raw CDP-shaped client (the bridge shim) for extras outside the BrowserPort
   * contract (clip recorder) — same surface as CdpBrowser.cdpClient(). */
  cdpClient() {
    return this.c;
  }

  /** A4 (P0) defense-in-depth: re-checks the Tier-4 allowedHosts guard at the
   * port layer against the LIVE page host, independent of driver/loop.ts's own
   * check — so a mutation reaching this port via the raw `cdp` bridge
   * passthrough (extension/sw.js) can't bypass the guard either. Mirrors
   * CdpBrowser.assertMutationAllowed. No-ops when the caller didn't pass
   * allowedHosts (see browser-port.ts's DEFAULT_ALLOWED_HOSTS doc comment for
   * why this isn't defaulted to localhost-only automatically). */
  private async assertMutationAllowed(what: string): Promise<void> {
    if (!this.opts.allowedHosts) return;
    const host = hostOfUrl(await this.url());
    assertMutationHostAllowed(host, this.opts.allowedHosts, what);
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

    if (this.opts.attachTabId !== undefined) {
      // Vibe mode: attach chrome.debugger to the user's EXISTING tab — never
      // create one, and remember to leave it open in close().
      const { tabId } = await this.b.call<{ tabId: number }>('ext.attachTab', {
        tabId: this.opts.attachTabId,
      }, 30_000, this.target);
      this.tabId = tabId;
      this.attachedExisting = true;
    } else {
      // SW creates the tab and attaches chrome.debugger (version 1.3) to it.
      const { tabId } = await this.b.call<{ tabId: number }>('ext.createTab', {
        url: this.opts.initialUrl ?? 'about:blank',
      }, 30_000, this.target);
      this.tabId = tabId;
    }

    // Build the CDP shim bound to this tab; enable the same domains CdpBrowser does.
    this.shim = createCdpShim(this.b, this.tab, { clientId: this.opts.clientId });
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
    await this.b.call('ext.navigate', { tabId: this.tab, url }, 30_000, this.target);
    await sleep(300); // let first paint + late console output settle
  }

  async url(): Promise<string> {
    const { url } = await this.b.call<{ url: string }>('ext.url', { tabId: this.tab }, 30_000, this.target);
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
      this.b.sendEvent('vibe.cursor', { tabId: this.tab, ...params }, this.target);
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

  private async centerOf(backendNodeId: number): Promise<{ x: number; y: number }> {
    await this.c.Page.bringToFront().catch(() => {});
    await this.c.DOM.scrollIntoViewIfNeeded({ backendNodeId }).catch(() => {});
    const { model } = await this.c.DOM.getBoxModel({ backendNodeId });
    const quad = model.content;
    return {
      x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
      y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
    };
  }

  async click(nodeId: string): Promise<void> {
    await this.assertMutationAllowed('click');
    const backendNodeId = this.backendNodeId(nodeId);
    const { x, y } = await this.centerOf(backendNodeId);
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
    await this.assertMutationAllowed('type');
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
    // Select-all (Ctrl+A) before inserting so type() REPLACES the field's current
    // value rather than appending — mirrors CdpBrowser. insertText replaces the
    // selection.
    await this.c.Input.dispatchKeyEvent({
      type: 'rawKeyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65,
    });
    await this.c.Input.dispatchKeyEvent({
      type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65,
    });
    await this.c.Input.insertText({ text });
    await sleep(150);

    // ALWAYS verify the value landed — mirrors CdpBrowser.verifyTyped exactly so
    // both transports behave identically (the v3 contract run is the parent's
    // integration check; this code is byte-for-byte the CDP path over the shim).
    // insertText satisfies React 18 controlled inputs (proven in v18 on the CDP
    // transport, which shares the identical capture/executor helpers); the
    // per-char fallback only engages on a real mismatch and closes the
    // silent-typing-failure bug class.
    await this.verifyTyped(backendNodeId, text);
  }

  async hover(nodeId: string): Promise<void> {
    const backendNodeId = this.backendNodeId(nodeId);
    const { x, y } = await this.centerOf(backendNodeId);
    this.emitCursor({ kind: 'move', x, y, caption: 'Hovering over ' + this.nodeLabel(nodeId) });
    await sleep(350);
    await this.c.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
    await sleep(250);
  }

  async pressKey(key: string): Promise<void> {
    await this.assertMutationAllowed('pressKey');
    await this.c.Page.bringToFront().catch(() => {});
    this.emitCursor({ kind: 'caption', caption: `Pressing ${key}` });
    await this.c.Input.dispatchKeyEvent({ type: 'keyDown', key });
    await this.c.Input.dispatchKeyEvent({ type: 'keyUp', key });
    await sleep(150);
  }

  async selectOption(nodeId: string, value: string): Promise<void> {
    await this.assertMutationAllowed('selectOption');
    const backendNodeId = this.backendNodeId(nodeId);
    this.emitCursor({ kind: 'caption', caption: 'Selecting ' + JSON.stringify(value) + ' in ' + this.nodeLabel(nodeId) });
    let objectId: string | undefined;
    try {
      const { object } = await this.c.DOM.resolveNode({ backendNodeId });
      objectId = object.objectId;
      if (!objectId) throw new Error(`selectOption() failed: node ${nodeId} is not a JS object`);
      const { result } = await this.c.Runtime.callFunctionOn({
        objectId,
        functionDeclaration: `function (value) {
          if (!(this instanceof HTMLSelectElement)) {
            return { ok: false, error: 'target is not a native select element' };
          }
          const match = Array.from(this.options).find((o) => o.value === value || o.text === value || o.label === value);
          if (!match) return { ok: false, error: 'option not found: ' + value };
          this.value = match.value;
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, value: this.value };
        }`,
        arguments: [{ value }],
        returnByValue: true,
      });
      const out = result.value as { ok?: boolean; error?: string } | undefined;
      if (!out?.ok) throw new Error(`selectOption() failed: ${out?.error ?? 'unknown error'}`);
    } finally {
      if (objectId) await this.c.Runtime.releaseObject({ objectId }).catch(() => {});
    }
    await sleep(200);
  }

  async reload(): Promise<void> {
    this.emitCursor({ kind: 'caption', caption: 'Reloading the page' });
    const loaded = this.c.Page.loadEventFired();
    await this.c.Page.reload({ ignoreCache: false });
    await Promise.race([loaded, sleep(15_000)]);
    await sleep(300);
  }

  async goBack(): Promise<void> {
    this.emitCursor({ kind: 'caption', caption: 'Going back' });
    const { entries, currentIndex } = await this.c.Page.getNavigationHistory();
    if (currentIndex <= 0) throw new Error('goBack() failed: no previous history entry');
    const loaded = this.c.Page.loadEventFired();
    await this.c.Page.navigateToHistoryEntry({ entryId: entries[currentIndex - 1].id });
    await Promise.race([loaded, sleep(15_000)]);
    await sleep(300);
  }

  async uploadFile(nodeId: string, paths: string[]): Promise<void> {
    await this.assertMutationAllowed('uploadFile');
    const backendNodeId = this.backendNodeId(nodeId);
    this.emitCursor({ kind: 'caption', caption: 'Uploading file(s) to ' + this.nodeLabel(nodeId) });
    await this.c.DOM.setFileInputFiles({ files: paths, backendNodeId });
    await sleep(150);
  }

  async dragAndDrop(sourceId: string, targetId: string): Promise<void> {
    await this.assertMutationAllowed('dragAndDrop');
    const src = await this.centerOf(this.backendNodeId(sourceId));
    const dst = await this.centerOf(this.backendNodeId(targetId));
    this.emitCursor({ kind: 'move', x: src.x, y: src.y, caption: 'Dragging ' + this.nodeLabel(sourceId) + ' to ' + this.nodeLabel(targetId) });
    await this.c.Input.dispatchMouseEvent({ type: 'mouseMoved', x: src.x, y: src.y });
    await this.c.Input.dispatchMouseEvent({ type: 'mousePressed', x: src.x, y: src.y, button: 'left', clickCount: 1 });
    const STEPS = 6;
    for (let i = 1; i <= STEPS; i++) {
      const x = src.x + ((dst.x - src.x) * i) / STEPS;
      const y = src.y + ((dst.y - src.y) * i) / STEPS;
      await this.c.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y, button: 'left' });
      await sleep(30);
    }
    await this.c.Input.dispatchMouseEvent({ type: 'mouseReleased', x: dst.x, y: dst.y, button: 'left', clickCount: 1 });
    this.emitCursor({ kind: 'click', x: dst.x, y: dst.y });
    await sleep(200);
  }

  async blur(nodeId: string): Promise<void> {
    await this.assertMutationAllowed('blur');
    const backendNodeId = this.backendNodeId(nodeId);
    let objectId: string | undefined;
    try {
      const { object } = await this.c.DOM.resolveNode({ backendNodeId });
      objectId = object.objectId;
      if (!objectId) return;
      await this.c.Runtime.callFunctionOn({
        objectId,
        functionDeclaration: 'function () { this.blur(); }',
        returnByValue: true,
      });
    } finally {
      if (objectId) await this.c.Runtime.releaseObject({ objectId }).catch(() => {});
    }
    await sleep(100);
  }

  async mouse(kind: 'move' | 'down' | 'up', x: number, y: number): Promise<void> {
    // loop.ts's MUTATING_ACTION_TYPES treats 'mouse' as one mutating action
    // type regardless of kind (only hover() is the read-only primitive).
    await this.assertMutationAllowed('mouse');
    await this.c.Page.bringToFront().catch(() => {});
    const type = kind === 'move' ? 'mouseMoved' : kind === 'down' ? 'mousePressed' : 'mouseReleased';
    await this.c.Input.dispatchMouseEvent({ type, x, y, button: 'left', clickCount: 1 });
    await sleep(kind === 'move' ? 50 : 150);
  }

  /** Tab primitives are NOT implemented for the daemon extension transport:
   * chrome.tabs.create/update/remove need a dedicated bridge RPC (ext.openTab
   * etc.) the service worker doesn't expose yet — chrome.debugger has no tab
   * lifecycle surface. Throw a clear error instead of a silent no-op so the
   * driver loop can fail the step/escalate rather than hang. */
  async openTab(_url: string): Promise<string> {
    throw new Error('openTab() is not supported in the extension transport yet (needs a chrome.tabs bridge RPC)');
  }

  async switchTab(_idOrIndex: string | number): Promise<void> {
    throw new Error('switchTab() is not supported in the extension transport yet (needs a chrome.tabs bridge RPC)');
  }

  async closeTab(_id: string): Promise<void> {
    throw new Error('closeTab() is not supported in the extension transport yet (needs a chrome.tabs bridge RPC)');
  }

  /** Read the field's live `.value` via DOM.resolveNode → Runtime.callFunctionOn
   * (Runtime.evaluate is not node-scoped). Mirrors CdpBrowser.liveValue. */
  private async liveValue(backendNodeId: number): Promise<string | undefined> {
    const { object } = await this.c.DOM.resolveNode({ backendNodeId });
    if (!object.objectId) return undefined;
    try {
      const { result } = await this.c.Runtime.callFunctionOn({
        objectId: object.objectId,
        functionDeclaration: 'function () { return this.value; }',
        returnByValue: true,
      });
      return result.value as string | undefined;
    } finally {
      await this.c.Runtime.releaseObject({ objectId: object.objectId }).catch(() => {});
    }
  }

  /** Confirm insertText took; else fall back to per-character key events and
   * re-verify, throwing on hard failure. Mirrors CdpBrowser.verifyTyped. */
  private async verifyTyped(backendNodeId: number, expected: string): Promise<void> {
    if ((await this.liveValue(backendNodeId)) === expected) return;
    await this.typeByKeyEvents(backendNodeId, expected);
    const after = await this.liveValue(backendNodeId);
    if (after !== expected) {
      throw new Error(
        `type() failed: field value is ${JSON.stringify(after)} after both insertText and ` +
          `per-character key events (expected ${JSON.stringify(expected)})`,
      );
    }
  }

  /** Per-character fallback: Ctrl+A clear then keyDown/char/keyUp per char.
   * Slow but bulletproof. Mirrors CdpBrowser.typeByKeyEvents. */
  private async typeByKeyEvents(backendNodeId: number, text: string): Promise<void> {
    await this.c.DOM.focus({ backendNodeId });
    await this.c.Input.dispatchKeyEvent({
      type: 'rawKeyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65,
    });
    await this.c.Input.dispatchKeyEvent({
      type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65,
    });
    for (const ch of text) {
      await this.c.Input.dispatchKeyEvent({ type: 'keyDown', text: ch, unmodifiedText: ch, key: ch });
      await this.c.Input.dispatchKeyEvent({ type: 'char', text: ch, unmodifiedText: ch, key: ch });
      await this.c.Input.dispatchKeyEvent({ type: 'keyUp', key: ch });
    }
    await sleep(100);
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

  /** Stamp a stable data-qa-id on a (typically name-less) node — recorder
   * fallback locator. Mirrors CdpBrowser.stampQaId over the bridge shim. */
  async stampQaId(nodeId: string): Promise<string | null> {
    const backendNodeId = this.backendNodeId(nodeId);
    let objectId: string | undefined;
    try {
      const { object } = await this.c.DOM.resolveNode({ backendNodeId });
      objectId = object.objectId;
      if (!objectId) return null;
      const id = `qa-${crypto.randomUUID().slice(0, 8)}`;
      await this.c.Runtime.callFunctionOn({
        objectId,
        functionDeclaration: 'function (id) { this.setAttribute("data-qa-id", id); return id; }',
        arguments: [{ value: id }],
        returnByValue: true,
      });
      return id;
    } catch {
      return null;
    } finally {
      if (objectId) await this.c.Runtime.releaseObject({ objectId }).catch(() => {});
    }
  }

  /** Resolve a previously stamped data-qa-id to a clickable nodeId (registers a
   * synthetic entry in the nodeMap). Mirrors CdpBrowser.findByQaId. */
  async findByQaId(qaId: string): Promise<string | null> {
    try {
      const { root } = await this.c.DOM.getDocument({ depth: 0 });
      const sel = `[data-qa-id="${qaId.replace(/"/g, '\\"')}"]`;
      const { nodeId: domNodeId } = await this.c.DOM.querySelector({ nodeId: root.nodeId, selector: sel });
      if (!domNodeId) return null;
      const { node } = await this.c.DOM.describeNode({ nodeId: domNodeId });
      const backendNodeId = node.backendNodeId;
      if (backendNodeId === undefined) return null;
      const synthetic = `qa:${qaId}`;
      this.nodeMap.set(synthetic, backendNodeId);
      return synthetic;
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    if (this.tabId !== null && this.bridge) {
      // Attached-to-existing (vibe): keepTab → SW only detaches the debugger so the
      // user's tab stays open. Created-by-us (tests): remove the tab as before.
      try {
        await this.b.call('ext.closeTab', { tabId: this.tabId, keepTab: this.attachedExisting }, 5_000, this.target);
      } catch { /* tab/SW gone */ }
    }
    this.shim?.dispose();
    this.shim = null;
    this.tabId = null;
    this.attachedExisting = false;
    this.capture = null;
    this.nodeMap.clear();
    if (this.ownsBridge && this.bridge) {
      try { await this.bridge.close(); } catch { /* already closed */ }
    }
    this.bridge = null;
    this.ownsBridge = false;
  }
}
