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
    // Input.insertText keeps the text out of key-event listeners — this is also
    // the future credential-vault path (the model never sees what gets typed).
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
