/* CdpBrowser — the MVP BrowserPort: plain CDP against a Chrome the daemon
 * spawns (or reuses) with --remote-debugging-port. Patterns lifted from the
 * spikes; capture uses native CDP domains (see capture/console-network.ts). */

import CDP from 'chrome-remote-interface';
import { ensureChrome, sleep, type LaunchOptions } from '../chrome/launch.js';
import { attachCapture, type CaptureBuffers } from '../capture/console-network.js';
import { setLogpointByContent } from '../capture/logpoints.js';
import { snapshotAxTree } from '../capture/axtree.js';
import type {
  AxSnapshot,
  BrowserPort,
  ConsoleEntry,
  LogpointSpec,
  NetworkEntry,
} from './browser-port.js';

export class CdpBrowser implements BrowserPort {
  private client: CDP.Client | null = null;
  private tabId: string | null = null;
  private capture: CaptureBuffers | null = null;
  /** planner nodeId ("n7") → CDP backendDOMNodeId; refreshed by every axTree(). */
  private nodeMap = new Map<string, number>();

  constructor(private readonly opts: LaunchOptions) {}

  private get c(): CDP.Client {
    if (!this.client) throw new Error('CdpBrowser: launch() first');
    return this.client;
  }

  /** Raw CDP client for extras outside the BrowserPort contract (clip recorder). */
  cdpClient(): CDP.Client {
    return this.c;
  }

  async launch(): Promise<void> {
    if (this.client) return;
    await ensureChrome(this.opts);
    const target = await CDP.New({ port: this.opts.port, url: 'about:blank' });
    this.tabId = (target as { id?: string }).id ?? (target as { targetId?: string }).targetId!;
    this.client = await CDP({ port: this.opts.port, target: this.tabId });
    await Promise.all([
      this.client.Page.enable(),
      this.client.Runtime.enable(),
      this.client.Debugger.enable(),
      this.client.DOM.enable(),
      this.client.Accessibility.enable(),
    ]);
    // capture must attach before the first navigation so nothing is missed
    this.capture = await attachCapture(this.client);
  }

  async navigate(url: string): Promise<void> {
    const loaded = this.c.Page.loadEventFired();
    await this.c.Page.navigate({ url });
    await Promise.race([loaded, sleep(15_000)]);
    await sleep(300); // let first paint + late console output settle
  }

  async url(): Promise<string> {
    const { result } = await this.c.Runtime.evaluate({ expression: 'location.href', returnByValue: true });
    return result.value as string;
  }

  async axTree(): Promise<AxSnapshot> {
    const { snapshot, nodeMap } = await snapshotAxTree(this.c);
    this.nodeMap = nodeMap;
    return snapshot;
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
    // Mirror ExtensionBrowser: foreground the tab before input. Raw CDP input
    // usually works on background tabs, but occluded-window throttling has
    // twice swallowed clicks in live headed runs — bringToFront removes the
    // variable (and the headed window is the "watch the robot" show anyway).
    await this.c.Page.bringToFront().catch(() => {});
    await this.c.DOM.scrollIntoViewIfNeeded({ backendNodeId }).catch(() => {});
    const { model } = await this.c.DOM.getBoxModel({ backendNodeId });
    const quad = model.content;
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await this.c.Input.dispatchMouseEvent({ type, x, y, button: 'left', clickCount: 1 });
    }
    await sleep(400); // allow handlers/navigation to kick off
  }

  async type(nodeId: string, text: string): Promise<void> {
    const backendNodeId = this.backendNodeId(nodeId);
    await this.c.DOM.focus({ backendNodeId });
    // Select all existing content first so insertText REPLACES rather than
    // appends at the caret (a filled field would otherwise concatenate, e.g.
    // "a@b.coma@b.co"). We stay on the Input domain — the future credential-
    // vault channel — by sending Ctrl+A as key events (modifiers:2 = Ctrl).
    await this.c.Input.dispatchKeyEvent({
      type: 'rawKeyDown',
      modifiers: 2,
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
    });
    await this.c.Input.dispatchKeyEvent({
      type: 'keyUp',
      modifiers: 2,
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
    });
    // Input.insertText keeps the text out of key-event listeners — this is also
    // the future credential-vault path (the model never sees what gets typed).
    // It replaces the current selection (the Ctrl+A above), giving replace
    // semantics the planner prompt promises.
    await this.c.Input.insertText({ text });
    await sleep(150);

    // ALWAYS verify the value actually landed. insertText satisfies React 18
    // controlled inputs (it dispatches beforeinput/input like IME insertion —
    // proven by test/v18.react-typing.ts), but rarer inputs (some masked /
    // heavily-controlled widgets) can swallow it. One cheap read closes the
    // silent-typing-failure bug class for good; the slow per-char path only
    // engages on a real mismatch.
    await this.verifyTyped(backendNodeId, text);
  }

  /** Read the field's live `.value` (Runtime.evaluate is NOT node-scoped — go
   * via DOM.resolveNode → Runtime.callFunctionOn on the resolved objectId). */
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

  /** Confirm insertText took; if not, fall back to per-character key events
   * (the slow-but-bulletproof path) and re-verify, throwing on a hard failure. */
  private async verifyTyped(backendNodeId: number, expected: string): Promise<void> {
    if ((await this.liveValue(backendNodeId)) === expected) return;
    // Fallback: re-select-all, then type each char as a full keyDown/char/keyUp.
    await this.typeByKeyEvents(backendNodeId, expected);
    const after = await this.liveValue(backendNodeId);
    if (after !== expected) {
      throw new Error(
        `type() failed: field value is ${JSON.stringify(after)} after both insertText and ` +
          `per-character key events (expected ${JSON.stringify(expected)})`,
      );
    }
  }

  /** Per-character fallback: clear via Ctrl+A then dispatch keyDown/char/keyUp
   * for every character so even inputs that ignore insertText receive real key
   * events. Slow but bulletproof. */
  private async typeByKeyEvents(backendNodeId: number, text: string): Promise<void> {
    await this.c.DOM.focus({ backendNodeId });
    await this.c.Input.dispatchKeyEvent({
      type: 'rawKeyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65,
    });
    await this.c.Input.dispatchKeyEvent({
      type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65,
    });
    // Replace the now-selected content with the first keystroke onward.
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

  async close(): Promise<void> {
    if (!this.client) return;
    try { await this.client.close(); } catch { /* already closed */ }
    if (this.tabId) {
      try { await CDP.Close({ port: this.opts.port, id: this.tabId }); } catch { /* gone */ }
    }
    this.client = null;
    this.tabId = null;
    this.capture = null;
    this.nodeMap.clear();
  }
}
