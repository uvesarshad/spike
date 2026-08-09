/* PlaywrightBrowser — A26: a third BrowserPort implementation. Attaches
 * Playwright (via chromium.connectOverCDP) to the SAME Chrome the daemon
 * already launches through ensureChrome() — Playwright never launches or
 * owns a browser process here. See
 * docs/plan/26-08-08-audit-deterministic-speed.md finding A26 (RESOLVED) and
 * the proving spike docs/plan/spikes/a26-connect-over-cdp.mjs (9/9 passed):
 * `browser.newContext()` over connectOverCDP gives genuinely isolated
 * cookies + localStorage per context, drives concurrently, and closing a
 * context never disturbs the daemon's original Chrome (Nano's tab lives in
 * the untouched default context).
 *
 * What Playwright buys over CdpBrowser, exposed here even though they are
 * not (yet) on BrowserPort — "natural wins" per the audit:
 *   - per-run BrowserContext isolation (A3)               — launch()
 *   - storageState()/setStorageState() (A6 primitive)      — below
 *   - context.route() interception/mocking (A13 primitive) — below
 *
 * What stays hand-built rather than reimplemented against Playwright's own
 * API: axTree() / console+network capture / logpoints / the invariant probe
 * all go through a RAW CDP session (`context.newCDPSession(page)`) fed into
 * the exact same snapshotAxTree() / attachCapture() / setLogpointByContent()
 * / INVARIANT_PROBE_JS that CdpBrowser uses — Playwright's own APIs have no
 * equivalent shape (no per-snapshot stable ids, no drain semantics, no raw
 * Debugger.setBreakpointByUrl escape hatch). `cdpClientFromSession()` below
 * adapts a Playwright CDPSession (`.send`/`.on`/`.off`) to look like a
 * chrome-remote-interface CDP.Client (`client.Domain.method(params)` /
 * `client.Domain.event(handler)`) — the same shape bridge/cdp-shim.ts
 * already builds for the extension transport (a Proxy over chrome.debugger),
 * just wired to a different underlying transport here.
 *
 * Every mutating primitive (click/type/hover/pressKey/selectOption/reload/
 * goBack/uploadFile/dragAndDrop/blur/mouse/navigate) therefore issues the
 * SAME CDP Input/DOM/Page calls CdpBrowser makes, through that shim — not
 * reimplemented against Playwright's own action APIs — so behavior is
 * identical by construction, not merely "in effect": the React-controlled-
 * input handling, the insertText→verify→per-character fallback, and the
 * select-all-at-the-DOM-level fix all carry over unchanged. See
 * cdp-browser.ts's own doc comments for the full "why" on each of those.
 *
 * The one place Playwright's OWN engine replaces CdpBrowser's hand-built
 * logic is waitForActionable(): it stamps a throwaway attribute on the node
 * and runs `locator.click({trial: true})`, which performs Playwright's full
 * attached/visible/stable/receives-events/enabled chain without ever
 * dispatching the click — a documented, battle-tested actionability engine
 * CdpBrowser had to hand-roll (see its ACTIONABLE_PROBE_JS doc comment for
 * the real rAF-related hang that drove that hand-rolled version). */

import crypto from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright-core';
import type CDP from 'chrome-remote-interface';
import { ensureChrome, type LaunchOptions } from '../chrome/launch.js';
import { attachCapture, type CaptureBuffers } from '../capture/console-network.js';
import { setLogpointByContent } from '../capture/logpoints.js';
import { snapshotAxTree } from '../capture/axtree.js';
import { INVARIANT_PROBE_JS } from '../assertions/invariants.js';
import {
  assertMutationHostAllowed,
  createNetworkIdleTracker,
  hostOfUrl,
  type AxSnapshot,
  type AxTreeOptions,
  type BrowserPort,
  type ConsoleEntry,
  type LogpointSpec,
  type NetworkEntry,
  type WaitForActionableOptions,
  type WaitForIdleOptions,
} from './browser-port.js';

/* ---------------------------------------------------------------------- *
 * CDP.Client-shaped adapter over a Playwright CDPSession
 * ---------------------------------------------------------------------- */

type CdpMember = (...args: unknown[]) => unknown;

/**
 * Build a Proxy that satisfies the subset of `CDP.Client` the capture/executor
 * code touches (`client.Domain.method(params)` for commands, `client.Domain.
 * event(handler)` to subscribe), routed over a Playwright CDPSession's own
 * `.send`/`.on`/`.off`. Mirrors bridge/cdp-shim.ts's `buildCdpClient()`
 * Proxy-over-domain shape exactly, just wired to a different transport.
 *
 * Disambiguation rule: a call with a single FUNCTION argument is an event
 * subscription (`on()`, returning an unsubscribe fn — matches chrome-remote-
 * interface's own convention of returning something callable there); any
 * other call (including ZERO arguments) is a command, sent with `params`
 * (or `undefined` for a zero-arg command like `Page.enable()`).
 *
 * Deliberately NOT implemented: chrome-remote-interface's "call an event
 * member with no arguments to get a promise for its next occurrence" sugar
 * (`client.Page.loadEventFired()`) — that convenience only works in the real
 * library because it knows from the CDP protocol schema which flat keys are
 * events vs commands; this generic shim has no such schema and a zero-arg
 * call must mean "command with no params" (the overwhelmingly common usage
 * across this codebase — `Page.enable()`, `Debugger.enable()`, `Page.
 * bringToFront()`, `Page.getNavigationHistory()`, …). Code in this file that
 * needs "resolve on the next occurrence of an event" uses the explicit
 * `waitForLoadEvent()` helper below instead, which subscribes with a real
 * handler function — the branch this shim DOES support.
 */
function cdpClientFromSession(session: CDPSession): CDP.Client {
  const send = session.send.bind(session) as unknown as (method: string, params?: unknown) => Promise<unknown>;
  const on = session.on.bind(session) as unknown as (event: string, listener: (p: unknown) => void) => unknown;
  const off = session.off.bind(session) as unknown as (event: string, listener: (p: unknown) => void) => unknown;

  const domainProxies = new Map<string, Record<string, CdpMember>>();
  const domainProxy = (domain: string): Record<string, CdpMember> => {
    let proxy = domainProxies.get(domain);
    if (proxy) return proxy;
    const members = new Map<string, CdpMember>();
    proxy = new Proxy({} as Record<string, CdpMember>, {
      get(_t, name: string | symbol) {
        if (typeof name !== 'string') return undefined;
        let m = members.get(name);
        if (!m) {
          const full = `${domain}.${name}`;
          m = (...args: unknown[]): unknown => {
            const [arg] = args;
            if (typeof arg === 'function') {
              const handler = arg as (p: unknown) => void;
              on(full, handler);
              return () => off(full, handler);
            }
            return send(full, arg);
          };
          members.set(name, m);
        }
        return m;
      },
    });
    domainProxies.set(domain, proxy);
    return proxy;
  };

  return new Proxy({} as Record<string, unknown>, {
    get(_t, prop: string | symbol) {
      if (typeof prop !== 'string') return undefined;
      // transport is owned by PlaywrightBrowser (rawSession.detach()) — this
      // mirrors cdp-shim.ts's own no-op close(), never actually called here.
      if (prop === 'close') return async () => {};
      if (prop === 'then') return undefined; // not a thenable
      return domainProxy(prop);
    },
  }) as unknown as CDP.Client;
}

/* ---------------------------------------------------------------------- *
 * PlaywrightBrowser
 * ---------------------------------------------------------------------- */

interface TabState {
  page: Page;
  session: CDP.Client;
  rawSession: CDPSession;
  capture: CaptureBuffers;
  idle: ReturnType<typeof createNetworkIdleTracker>;
}

export class PlaywrightBrowser implements BrowserPort {
  private browser: Browser | null = null;
  private ctx: BrowserContext | null = null;
  private page: Page | null = null;
  private session: CDP.Client | null = null;
  private rawSession: CDPSession | null = null;
  private capture: CaptureBuffers | null = null;
  private idle: ReturnType<typeof createNetworkIdleTracker> | null = null;
  /** planner nodeId ("n7") → CDP backendDOMNodeId; refreshed by every axTree(). */
  private nodeMap = new Map<string, number>();

  /** Opaque tab bookkeeping — mirrors CdpBrowser's mainTabId/otherTabs/openOrder
   * shape (see that file's doc comments), except ids here are synthetic
   * strings we mint ourselves rather than real CDP target ids: BrowserPort's
   * contract only promises an "opaque id usable with switchTab()/closeTab()",
   * not a real target id, and Playwright's Page object exposes no public
   * target-id accessor. */
  private readonly mainTabId = 'main';
  private tabId = this.mainTabId;
  private tabSeq = 0;
  private openOrder: string[] = [];
  private otherTabs = new Map<string, TabState>();

  /** allowedHosts (A4, P0 defense-in-depth): see cdp-browser.ts's identical
   * field/method for the full rationale — re-checked here independent of
   * driver/loop.ts's own Tier-4 guard. */
  constructor(private readonly opts: LaunchOptions & { allowedHosts?: string[] }) {}

  private get c(): CDP.Client {
    if (!this.session) throw new Error('PlaywrightBrowser: launch() first');
    return this.session;
  }

  private get p(): Page {
    if (!this.page) throw new Error('PlaywrightBrowser: launch() first');
    return this.page;
  }

  private get ctxc(): BrowserContext {
    if (!this.ctx) throw new Error('PlaywrightBrowser: launch() first');
    return this.ctx;
  }

  private async assertMutationAllowed(what: string): Promise<void> {
    if (!this.opts.allowedHosts) return;
    const host = hostOfUrl(await this.url());
    assertMutationHostAllowed(host, this.opts.allowedHosts, what);
  }

  /** Raw CDP-shaped client for extras outside the BrowserPort contract (clip
   * recorder) — same role as CdpBrowser.cdpClient(). */
  cdpClient(): CDP.Client {
    return this.c;
  }

  /* -------------------------- lifecycle -------------------------- */

  async launch(): Promise<void> {
    if (this.browser) return;
    // The daemon (or whatever caller constructed this port) owns Chrome's
    // lifecycle exactly as it does for CdpBrowser — Playwright ONLY attaches.
    await ensureChrome(this.opts);
    this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.opts.port}`);
    // A3: a fresh, genuinely isolated context per run (cookies + localStorage
    // — proven by the A26 spike) — NOT the default context the daemon's other
    // tabs (e.g. Nano's warm session) live in.
    this.ctx = await this.browser.newContext();
    this.page = await this.ctx.newPage();
    const attached = await this.attachSession(this.page);
    this.session = attached.session;
    this.rawSession = attached.rawSession;
    this.capture = attached.capture;
    this.idle = attached.idle;
  }

  /** Attach a fresh CDP session to `page`, enable the domains every port
   * primitive needs (mirrors CdpBrowser.launch()'s Promise.all exactly), and
   * wire capture + the network-idle tracker. Used for the main tab AND every
   * tab openTab() creates. */
  private async attachSession(page: Page): Promise<TabState> {
    const rawSession = await this.ctxc.newCDPSession(page);
    const session = cdpClientFromSession(rawSession);
    await Promise.all([
      session.Page.enable(),
      session.Runtime.enable(),
      session.Debugger.enable(),
      session.DOM.enable(),
      session.Accessibility.enable(),
    ]);
    // capture must attach before the first navigation so nothing is missed —
    // same ordering constraint as CdpBrowser.launch().
    const capture = await attachCapture(session);
    const idle = createNetworkIdleTracker(session);
    return { page, session, rawSession, capture, idle };
  }

  /** Resolves once `client`'s Page.loadEventFired next fires, or `timeoutMs`
   * elapses — whichever first. Never rejects (mirrors CdpBrowser's
   * `Promise.race([loaded, sleep(15000)])`), because a slow/never-loading
   * page must not hang or fail the run; the caller's next axTree()/
   * screenshot() reveals whatever state the page is actually in. See this
   * file's top-of-module comment for why this exists instead of chrome-
   * remote-interface's zero-arg promise sugar. */
  private waitForLoadEvent(client: CDP.Client, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          unsubscribe();
        } catch {
          /* already gone */
        }
        resolve();
      };
      const unsubscribe = client.Page.loadEventFired(() => finish()) as unknown as () => void;
      const timer = setTimeout(finish, timeoutMs);
    });
  }

  /* -------------------------- A4: auto-waiting -------------------------- */

  /** A4 (P0): resolves once Network has been quiet for `networkQuietMs` (or
   * `timeoutMs` elapses) on the CURRENTLY active tab's tracker — the exact
   * same `createNetworkIdleTracker()` CdpBrowser/ExtensionBrowser share (see
   * browser-port.ts), just fed by a Playwright CDPSession instead of a
   * chrome-remote-interface client. */
  async waitForIdle(opts?: WaitForIdleOptions): Promise<void> {
    if (!this.idle) return;
    await this.idle.waitForIdle(opts);
  }

  /** A4 (P0): Playwright's OWN actionability engine, not CdpBrowser's hand-
   * built rAF-avoiding probe. Stamps a throwaway `data-qa-probe` attribute on
   * the node (via CDP — the AX-tree nodeId only resolves to a backendNodeId,
   * not a CSS selector) so a real Playwright `Locator` can be built for it,
   * then runs `locator.click({trial: true})`: Playwright's documented way to
   * run the full attached → visible → stable → receives-events → enabled
   * chain WITHOUT ever dispatching the click. Throws (not a silent timeout)
   * on failure — matching BrowserPort's documented contract exactly. */
  async waitForActionable(nodeId: string, opts?: WaitForActionableOptions): Promise<void> {
    const timeoutMs = opts?.timeoutMs ?? 5000;
    const backendNodeId = this.backendNodeId(nodeId);
    const probeId = await this.stampTempAttr(backendNodeId, 'data-qa-probe');
    if (probeId === null) {
      throw new Error(`waitForActionable(${nodeId}): could not resolve node to probe (detached?)`);
    }
    try {
      const locator = this.p.locator(`[data-qa-probe="${probeId}"]`);
      await locator.click({ trial: true, timeout: timeoutMs });
    } catch {
      throw new Error(`waitForActionable(${nodeId}): not actionable (attached/visible/enabled/stable) after ${timeoutMs}ms`);
    } finally {
      await this.clearTempAttr(backendNodeId, 'data-qa-probe').catch(() => {});
    }
  }

  /* -------------------------- node resolution -------------------------- */

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

  private async stampTempAttr(backendNodeId: number, attr: string): Promise<string | null> {
    let objectId: string | undefined;
    try {
      const { object } = await this.c.DOM.resolveNode({ backendNodeId });
      objectId = object.objectId;
      if (!objectId) return null;
      const id = `qap-${crypto.randomUUID().slice(0, 8)}`;
      await this.c.Runtime.callFunctionOn({
        objectId,
        functionDeclaration: `function (id) { this.setAttribute(${JSON.stringify(attr)}, id); return id; }`,
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

  private async clearTempAttr(backendNodeId: number, attr: string): Promise<void> {
    let objectId: string | undefined;
    try {
      const { object } = await this.c.DOM.resolveNode({ backendNodeId });
      objectId = object.objectId;
      if (!objectId) return;
      await this.c.Runtime.callFunctionOn({
        objectId,
        functionDeclaration: `function () { this.removeAttribute(${JSON.stringify(attr)}); }`,
        returnByValue: true,
      });
    } catch {
      /* node already gone — nothing to clean up */
    } finally {
      if (objectId) await this.c.Runtime.releaseObject({ objectId }).catch(() => {});
    }
  }

  /* -------------------------- navigation -------------------------- */

  async navigate(url: string): Promise<void> {
    const loaded = this.waitForLoadEvent(this.c, 15_000);
    await this.c.Page.navigate({ url });
    await loaded;
    // A4 (P0): waits for the network to actually go quiet (bounded), not a
    // flat sleep — see createNetworkIdleTracker's doc comment.
    await this.waitForIdle();
  }

  async url(): Promise<string> {
    const { result } = await this.c.Runtime.evaluate({ expression: 'location.href', returnByValue: true });
    return result.value as string;
  }

  async reload(): Promise<void> {
    const loaded = this.waitForLoadEvent(this.c, 15_000);
    await this.c.Page.reload({ ignoreCache: false });
    await loaded;
    await this.waitForIdle();
  }

  async goBack(): Promise<void> {
    const { entries, currentIndex } = await this.c.Page.getNavigationHistory();
    if (currentIndex <= 0) throw new Error('goBack() failed: no previous history entry');
    const loaded = this.waitForLoadEvent(this.c, 15_000);
    await this.c.Page.navigateToHistoryEntry({ entryId: entries[currentIndex - 1].id });
    await loaded;
    await this.waitForIdle();
  }

  /* -------------------------- a11y tree -------------------------- */

  async axTree(opts?: AxTreeOptions): Promise<AxSnapshot> {
    const { snapshot, nodeMap } = await snapshotAxTree(this.c, opts);
    this.nodeMap = nodeMap;
    return snapshot;
  }

  /** See BrowserPort.peekAxTree — observer snapshot, planner ids left bound. */
  async peekAxTree(): Promise<AxSnapshot> {
    const { snapshot } = await snapshotAxTree(this.c);
    return snapshot;
  }

  /* -------------------------- mutating primitives -------------------------- *
   * Identical CDP Input/DOM calls to CdpBrowser (see that file for the full
   * "why" behind each design choice — insertText-then-verify, select-all at
   * the DOM level, the per-character fallback) — just issued through this
   * port's own CDP session rather than a chrome-remote-interface client. */

  async click(nodeId: string): Promise<void> {
    await this.assertMutationAllowed('click');
    const backendNodeId = this.backendNodeId(nodeId);
    const { x, y } = await this.centerOf(backendNodeId);
    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await this.c.Input.dispatchMouseEvent({ type, x, y, button: 'left', clickCount: 1 });
    }
    await this.waitForIdle({ networkQuietMs: 200, timeoutMs: 3000 });
  }

  async type(nodeId: string, text: string): Promise<void> {
    await this.assertMutationAllowed('type');
    const backendNodeId = this.backendNodeId(nodeId);
    await this.c.DOM.focus({ backendNodeId });
    await this.selectAllIn(backendNodeId);
    await this.c.Input.insertText({ text });
    await this.waitForIdle({ networkQuietMs: 150, timeoutMs: 1500 });
    await this.verifyTyped(backendNodeId, text);
  }

  async hover(nodeId: string): Promise<void> {
    const backendNodeId = this.backendNodeId(nodeId);
    const { x, y } = await this.centerOf(backendNodeId);
    await this.c.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
    await this.waitForIdle({ networkQuietMs: 150, timeoutMs: 1000 });
  }

  async pressKey(key: string): Promise<void> {
    await this.assertMutationAllowed('pressKey');
    await this.c.Page.bringToFront().catch(() => {});
    await this.c.Input.dispatchKeyEvent({ type: 'keyDown', key });
    await this.c.Input.dispatchKeyEvent({ type: 'keyUp', key });
    await this.waitForIdle({ networkQuietMs: 150, timeoutMs: 1500 });
  }

  async selectOption(nodeId: string, value: string): Promise<void> {
    await this.assertMutationAllowed('selectOption');
    const backendNodeId = this.backendNodeId(nodeId);
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
    await this.waitForIdle({ networkQuietMs: 200, timeoutMs: 2000 });
  }

  async uploadFile(nodeId: string, paths: string[]): Promise<void> {
    await this.assertMutationAllowed('uploadFile');
    const backendNodeId = this.backendNodeId(nodeId);
    await this.c.DOM.setFileInputFiles({ files: paths, backendNodeId });
    await this.waitForIdle({ networkQuietMs: 200, timeoutMs: 2000 });
  }

  async dragAndDrop(sourceId: string, targetId: string): Promise<void> {
    await this.assertMutationAllowed('dragAndDrop');
    const src = await this.centerOf(this.backendNodeId(sourceId));
    const dst = await this.centerOf(this.backendNodeId(targetId));
    await this.c.Input.dispatchMouseEvent({ type: 'mouseMoved', x: src.x, y: src.y });
    await this.c.Input.dispatchMouseEvent({ type: 'mousePressed', x: src.x, y: src.y, button: 'left', clickCount: 1 });
    const STEPS = 6;
    for (let i = 1; i <= STEPS; i++) {
      const x = src.x + ((dst.x - src.x) * i) / STEPS;
      const y = src.y + ((dst.y - src.y) * i) / STEPS;
      await this.c.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y, button: 'left' });
      await new Promise<void>((r) => setTimeout(r, 30));
    }
    await this.c.Input.dispatchMouseEvent({ type: 'mouseReleased', x: dst.x, y: dst.y, button: 'left', clickCount: 1 });
    await this.waitForIdle({ networkQuietMs: 200, timeoutMs: 2000 });
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
    await this.waitForIdle({ networkQuietMs: 100, timeoutMs: 800 });
  }

  async mouse(kind: 'move' | 'down' | 'up', x: number, y: number): Promise<void> {
    await this.assertMutationAllowed('mouse');
    await this.c.Page.bringToFront().catch(() => {});
    const type = kind === 'move' ? 'mouseMoved' : kind === 'down' ? 'mousePressed' : 'mouseReleased';
    await this.c.Input.dispatchMouseEvent({ type, x, y, button: 'left', clickCount: 1 });
    await this.waitForIdle({ networkQuietMs: 100, timeoutMs: kind === 'move' ? 500 : 1000 });
  }

  /** Read the field's live `.value` — see CdpBrowser's identical helper. */
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

  /** Select the whole field's content at the DOM level so a following
   * Input.insertText REPLACES rather than appends — see cdp-browser.ts's
   * identical method for the macOS Cmd+A vs Ctrl+A gotcha this sidesteps. */
  private async selectAllIn(backendNodeId: number): Promise<void> {
    const { object } = await this.c.DOM.resolveNode({ backendNodeId });
    if (!object.objectId) return;
    try {
      await this.c.Runtime.callFunctionOn({
        objectId: object.objectId,
        functionDeclaration: `function () {
          this.focus();
          if (typeof this.select === 'function') { this.select(); return; }
          if (typeof this.setSelectionRange === 'function') {
            this.setSelectionRange(0, String(this.value ?? '').length);
            return;
          }
          const range = document.createRange();
          range.selectNodeContents(this);
          const sel = getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }`,
      });
    } finally {
      await this.c.Runtime.releaseObject({ objectId: object.objectId }).catch(() => {});
    }
  }

  /** Confirm insertText took; fall back to per-character key events and
   * re-verify, throwing on a hard failure — see cdp-browser.ts's identical
   * method for why this polls rather than reading once. */
  private async verifyTyped(backendNodeId: number, expected: string): Promise<void> {
    const deadline = Date.now() + 600;
    for (;;) {
      if ((await this.liveValue(backendNodeId)) === expected) return;
      if (Date.now() >= deadline) break;
      await new Promise<void>((r) => setTimeout(r, 40));
    }
    await this.typeByKeyEvents(backendNodeId, expected);
    const after = await this.liveValue(backendNodeId);
    if (after !== expected) {
      throw new Error(
        `type() failed: field value is ${JSON.stringify(after)} after both insertText and ` +
          `per-character key events (expected ${JSON.stringify(expected)})`,
      );
    }
  }

  /** Per-character fallback — see cdp-browser.ts's identical method for why
   * rawKeyDown (not keyDown) is required to avoid double-insertion. */
  private async typeByKeyEvents(backendNodeId: number, text: string): Promise<void> {
    await this.c.DOM.focus({ backendNodeId });
    await this.selectAllIn(backendNodeId);
    for (const ch of text) {
      await this.c.Input.dispatchKeyEvent({ type: 'rawKeyDown', key: ch, unmodifiedText: ch });
      await this.c.Input.dispatchKeyEvent({ type: 'char', text: ch, unmodifiedText: ch, key: ch });
      await this.c.Input.dispatchKeyEvent({ type: 'keyUp', key: ch });
    }
    await this.waitForIdle({ networkQuietMs: 150, timeoutMs: 1500 });
  }

  /* -------------------------- #9 qaId stamping -------------------------- */

  /** Stamp a stable `data-qa-id` and return it — identical to CdpBrowser's
   * method (see there for the full rationale). */
  async stampQaId(nodeId: string): Promise<string | null> {
    const backendNodeId = this.backendNodeId(nodeId);
    return this.stampTempAttr(backendNodeId, 'data-qa-id');
  }

  /** Find a node by stamped `data-qa-id` and register it into the live
   * nodeMap under a synthetic `qa:<id>` key — identical to CdpBrowser's
   * method. */
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

  /* -------------------------- evidence -------------------------- */

  async screenshot(): Promise<Buffer> {
    const { data } = await this.c.Page.captureScreenshot({ format: 'png' });
    return Buffer.from(data, 'base64');
  }

  /** A24 Tier-0 oracle — identical to CdpBrowser's method: evaluates the ONE
   * compile-time constant probe, never caller-supplied JS. */
  async probeInvariants(): Promise<unknown> {
    const { result } = await this.c.Runtime.evaluate({
      expression: INVARIANT_PROBE_JS,
      returnByValue: true,
      awaitPromise: false,
    });
    return result?.value;
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

  /* -------------------------- tabs -------------------------- */

  async openTab(url: string): Promise<string> {
    const page = await this.ctxc.newPage();
    const attached = await this.attachSession(page);
    const loaded = this.waitForLoadEvent(attached.session, 15_000);
    await attached.session.Page.navigate({ url });
    await loaded;
    const id = `tab-${++this.tabSeq}`;
    this.otherTabs.set(id, attached);
    this.openOrder.push(id);
    return id;
  }

  /** idOrIndex accepts either the literal id openTab() returned OR the
   * numeric replay convention (0 = the tab launch() started with, N>=1 = the
   * Nth tab openTab() created) — identical to CdpBrowser's resolveTabIndex. */
  private resolveTabIndex(idOrIndex: string | number): string {
    if (typeof idOrIndex === 'string') return idOrIndex;
    if (idOrIndex === 0) return this.mainTabId;
    const id = this.openOrder[idOrIndex - 1];
    if (!id) throw new Error(`switchTab(${idOrIndex}): no tab was opened at that index`);
    return id;
  }

  async switchTab(idOrIndex: string | number): Promise<void> {
    const targetId = this.resolveTabIndex(idOrIndex);
    if (targetId === this.tabId) return; // already active
    const target = this.otherTabs.get(targetId);
    if (!target) {
      throw new Error(`switchTab: unknown tab id "${targetId}" — open it with openTab() first`);
    }
    // Stash the currently active tab (page + its ALREADY-attached session/
    // capture/idle — never re-attach) so it stays reachable for a later
    // switchTab() — same discipline as CdpBrowser.
    if (this.page && this.session && this.rawSession && this.capture && this.idle) {
      this.otherTabs.set(this.tabId, {
        page: this.page,
        session: this.session,
        rawSession: this.rawSession,
        capture: this.capture,
        idle: this.idle,
      });
    }
    this.otherTabs.delete(targetId);
    this.page = target.page;
    this.session = target.session;
    this.rawSession = target.rawSession;
    this.capture = target.capture;
    this.idle = target.idle;
    this.tabId = targetId;
    this.nodeMap.clear();
  }

  async closeTab(id: string): Promise<void> {
    if (id === this.tabId) {
      throw new Error('closeTab: cannot close the active tab — switchTab() to another tab first');
    }
    const target = this.otherTabs.get(id);
    if (target) {
      await target.rawSession.detach().catch(() => {});
      await target.page.close().catch(() => {});
      this.otherTabs.delete(id);
    }
  }

  /* -------------------------- A26 natural wins -------------------------- *
   * Not (yet) on BrowserPort — exposed as real methods for later work
   * (A6 storageState, A13 route()) rather than left as an interface gap. */

  /** A6 primitive: cookies + localStorage (+ optionally IndexedDB/WebAuthn
   * credentials) snapshot for this run's isolated context — the "log in
   * once, inject into every subsequent flow" fixture the audit calls out. */
  async storageState(...args: Parameters<BrowserContext['storageState']>): ReturnType<BrowserContext['storageState']> {
    return this.ctxc.storageState(...args);
  }

  /** Inverse of storageState() — Playwright's own semantics: "clears the
   * existing cookies, local storage, IndexedDB entries… and sets the new
   * storage state" on this run's context. */
  async setStorageState(...args: Parameters<BrowserContext['setStorageState']>): Promise<void> {
    await this.ctxc.setStorageState(...args);
  }

  /** A13 primitive: network interception/mocking (block third-party/
   * analytics, force error states, request-level assertions) for this run's
   * context — a thin passthrough to Playwright's own context.route(). */
  async route(...args: Parameters<BrowserContext['route']>): Promise<void> {
    await this.ctxc.route(...args);
  }

  /* -------------------------- teardown -------------------------- */

  async close(): Promise<void> {
    for (const [, tab] of this.otherTabs) {
      await tab.rawSession.detach().catch(() => {});
      await tab.page.close().catch(() => {});
    }
    this.otherTabs.clear();
    if (this.rawSession) await this.rawSession.detach().catch(() => {});
    if (this.page) await this.page.close().catch(() => {});
    // Closing ONLY this run's context + disconnecting Playwright — per
    // Playwright's own documented contract for a connectOverCDP-obtained
    // Browser: "clears all created contexts belonging to this browser and
    // disconnects from the browser server" (does NOT kill the underlying
    // process for a browser Playwright didn't launch). The daemon's Chrome,
    // its default context, and any other tab (Nano's warm session) survive —
    // confirmed live by the A26 spike's "closing one context leaves others +
    // original Chrome intact" check and by this port's own test suite, which
    // launches a SECOND PlaywrightBrowser against the same Chrome after the
    // first one's close().
    if (this.ctx) await this.ctx.close().catch(() => {});
    if (this.browser) await this.browser.close().catch(() => {});
    this.browser = null;
    this.ctx = null;
    this.page = null;
    this.session = null;
    this.rawSession = null;
    this.capture = null;
    this.idle = null;
    this.nodeMap.clear();
    this.openOrder = [];
    this.tabId = this.mainTabId;
  }
}
