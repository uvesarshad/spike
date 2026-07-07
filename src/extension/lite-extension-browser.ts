/* LiteExtensionBrowser — the BrowserPort for LITE mode: drives the page via
 * chrome.debugger DIRECTLY (no daemon, no WebSocket bridge). It is a transport-
 * pure clone of src/ports/extension-browser.ts: all chrome.* access is injected
 * as `deps` by the service worker, so this file references no chrome.* global and
 * typechecks under the Node tsconfig (bundled for the SW by tsup).
 *
 * The capture/executor helpers (snapshotAxTree, attachCapture, setLogpointByContent)
 * and the entire click/type/verifyTyped logic are reused BYTE-FOR-BYTE from the
 * bridge path — the only difference is where the CDP client comes from
 * (buildCdpClient over an injected chrome.debugger transport vs the bridge). */

import { attachCapture, type CaptureBuffers } from '../capture/console-network.js';
import { setLogpointByContent } from '../capture/logpoints.js';
import { snapshotAxTree } from '../capture/axtree.js';
import { buildCdpClient, type CdpShim, type CdpTransport } from '../bridge/cdp-shim.js';
import type {
  AxNode,
  AxSnapshot,
  BrowserPort,
  ConsoleEntry,
  LogpointSpec,
  NetworkEntry,
} from '../ports/browser-port.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Everything platform-specific the SW injects. Keeps this module chrome-free. */
export interface LiteBrowserDeps {
  /** CDP transport bound to the run's tab (chrome.debugger.sendCommand + onEvent). */
  transport: CdpTransport;
  /** Navigate the tab and resolve when load completes (SW: chrome.tabs.onUpdated). */
  navigate(url: string): Promise<void>;
  /** Current tab URL. */
  getUrl(): Promise<string>;
  /** Detach the debugger; the user's tab stays open (vibe semantics). */
  detach(): Promise<void>;
  /** Ghost-cursor / caption overlay events (fire-and-forget, cosmetic). */
  onCursor(params: Record<string, unknown>): void;
}

export class LiteExtensionBrowser implements BrowserPort {
  private shim: CdpShim | null = null;
  private capture: CaptureBuffers | null = null;
  /** planner nodeId ("n7") → backendDOMNodeId; refreshed by every axTree(). */
  private nodeMap = new Map<string, number>();
  private lastSnapshot: AxSnapshot | null = null;

  constructor(private readonly deps: LiteBrowserDeps) {}

  private get c() {
    if (!this.shim) throw new Error('LiteExtensionBrowser: launch() first');
    return this.shim.client;
  }

  /** Raw CDP-shaped client for extras outside the BrowserPort contract. */
  cdpClient() {
    return this.c;
  }

  async launch(): Promise<void> {
    if (this.shim) return;
    // The SW has already created/attached the tab + chrome.debugger; we just
    // build the CDP client over the injected transport and enable the domains.
    this.shim = buildCdpClient(this.deps.transport);
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
    await this.deps.navigate(url);
    await sleep(300); // let first paint + late console output settle
  }

  async url(): Promise<string> {
    return this.deps.getUrl();
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

  /** Fire a cursor overlay event; never let UI fan-out fail the action. */
  private emitCursor(params: Record<string, unknown>): void {
    try {
      this.deps.onCursor(params);
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
    const backendNodeId = this.backendNodeId(nodeId);
    const { x, y } = await this.centerOf(backendNodeId);
    this.emitCursor({ kind: 'move', x, y, caption: 'Clicking ' + this.nodeLabel(nodeId) });
    await sleep(350);
    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await this.c.Input.dispatchMouseEvent({ type, x, y, button: 'left', clickCount: 1 });
    }
    this.emitCursor({ kind: 'click', x, y });
    await sleep(400);
  }

  async type(nodeId: string, text: string): Promise<void> {
    const backendNodeId = this.backendNodeId(nodeId);
    await this.c.Page.bringToFront().catch(() => {});
    await this.c.DOM.scrollIntoViewIfNeeded({ backendNodeId }).catch(() => {});
    try {
      const { model } = await this.c.DOM.getBoxModel({ backendNodeId });
      const quad = model.content;
      const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
      const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
      this.emitCursor({ kind: 'type', x, y, caption: 'Typing into ' + this.nodeLabel(nodeId) });
      await sleep(350);
    } catch {
      this.emitCursor({ kind: 'caption', caption: 'Typing into ' + this.nodeLabel(nodeId) });
    }
    await this.c.DOM.focus({ backendNodeId });
    // Select-all (Ctrl+A) before inserting so type() REPLACES the field's value.
    await this.c.Input.dispatchKeyEvent({
      type: 'rawKeyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65,
    });
    await this.c.Input.dispatchKeyEvent({
      type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65,
    });
    await this.c.Input.insertText({ text });
    await sleep(150);
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
    await this.c.Page.bringToFront().catch(() => {});
    this.emitCursor({ kind: 'caption', caption: `Pressing ${key}` });
    await this.c.Input.dispatchKeyEvent({ type: 'keyDown', key });
    await this.c.Input.dispatchKeyEvent({ type: 'keyUp', key });
    await sleep(150);
  }

  async selectOption(nodeId: string, value: string): Promise<void> {
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

  /** Read the field's live `.value` via DOM.resolveNode → Runtime.callFunctionOn. */
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

  /** Confirm insertText took; else fall back to per-character key events. */
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

  /** Per-character fallback: Ctrl+A clear then keyDown/char/keyUp per char. */
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

  /** Stamp a stable data-qa-id on a (typically name-less) node — recorder fallback. */
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

  /** Resolve a previously stamped data-qa-id to a clickable nodeId. */
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
    try {
      await this.deps.detach();
    } catch {
      /* tab/debugger already gone */
    }
    this.shim?.dispose();
    this.shim = null;
    this.capture = null;
    this.nodeMap.clear();
    this.lastSnapshot = null;
  }
}
