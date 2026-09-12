/* CdpBrowser — the MVP BrowserPort: plain CDP against a Chrome the daemon
 * spawns (or reuses) with --remote-debugging-port. Patterns lifted from the
 * spikes; capture uses native CDP domains (see capture/console-network.ts). */

import crypto from 'node:crypto';
import CDP from 'chrome-remote-interface';
import { ensureChrome, sleep, type LaunchOptions } from '../chrome/launch.js';
import { attachCapture, type CaptureBuffers } from '../capture/console-network.js';
import { setLogpointByContent } from '../capture/logpoints.js';
import { snapshotAxTree, TESTID_ATTRS } from '../capture/axtree.js';
import { INVARIANT_PROBE_JS } from '../assertions/invariants.js';
import {
  assertMutationHostAllowed,
  createNetworkIdleTracker,
  hostOfUrl,
  raceTimeout,
  type AxSnapshot,
  type AxTreeOptions,
  type BrowserPort,
  type ConsoleEntry,
  type LogpointSpec,
  type NetworkEntry,
  type NewTabInfo,
  type WaitForActionableOptions,
  type WaitForIdleOptions,
} from './browser-port.js';

/** A4 (P0): in-page probe for BrowserPort.waitForActionable, run via a PLAIN
 * SYNCHRONOUS Runtime.callFunctionOn (no `awaitPromise`, no
 * `requestAnimationFrame`) — it returns instantly regardless of whether the
 * tab is painting. An earlier version used a double-rAF in-page Promise to
 * get a literal "two consecutive animation frames" read; that HUNG for
 * real (reproduced live: a 9-minute stall on a single step) because
 * Chromium throttles/pauses rAF callbacks for a tab that isn't the
 * OS-foreground one (e.g. a concurrent run's `Page.bringToFront()` on a
 * different tab steals focus — see also `openTab`/`switchTab`, which put
 * MULTIPLE tabs in the same browser, only one of which can be foreground),
 * and `awaitPromise: true` means the CDP command itself does not return
 * until that in-page promise settles — nothing in the calling loop ever got
 * a chance to check its own deadline. Stability is now measured the safe
 * way: TWO separate calls to this synchronous probe, `POLL_MS` apart, from
 * Node — see waitForActionable(). */
const ACTIONABLE_PROBE_JS = `function () {
  const cs = getComputedStyle(this);
  const rect = this.getBoundingClientRect();
  return {
    visible: cs.visibility !== 'hidden' && cs.display !== 'none' && rect.width > 0 && rect.height > 0,
    enabled: !this.disabled && this.getAttribute('aria-disabled') !== 'true',
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  };
}`;

interface ActionableProbeResult {
  visible: boolean;
  enabled: boolean;
  rect: { x: number; y: number; width: number; height: number };
}

/** A4 (P0): throwing timeout wrapper — mirrors driver/loop.ts's own
 * `withTimeout` (same reject-with-timer shape), kept local here rather than
 * imported to avoid a driver→port circular dependency. `raceTimeout` above
 * (browser-port.ts) resolves to a FALLBACK instead of rejecting, which is
 * right for the actionability poll loop but wrong here: `assertMutationAllowed`
 * and `url()` need a real rejection so the driver's per-action catch (loop.ts,
 * ~line 1249) classifies it as a failed step, not a silently-swallowed no-op
 * that lets a mutation through unchecked. Used for calls with no other bound —
 * a page stuck in a synchronous JS loop (the exact bug class this tool exists
 * to catch) would otherwise wedge Runtime.evaluate forever. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CdpBrowser.${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** A4 (P0): matches driver/loop.ts's own CDP_CALL_TIMEOUT_MS — a dropped
 * debugger connection or a page wedged in a synchronous loop should surface
 * quickly rather than hang the run. */
const CDP_CALL_TIMEOUT_MS = 15_000;

/** A49 (P2): how old an unresolved network request must be before the
 * periodic sweep drops it as stale — see CaptureBuffers.sweepStalePending's
 * doc comment (console-network.ts) for why this exists at all. */
const STALE_PENDING_MAX_AGE_MS = 120_000;
/** A49 (P2): how often the sweep runs. Well under STALE_PENDING_MAX_AGE_MS so
 * a stale entry is caught within one interval of crossing the age threshold,
 * without adding meaningful CPU/wakeup overhead to a long session. */
const STALE_PENDING_SWEEP_INTERVAL_MS = 30_000;

/** True when two consecutive probe reads describe the SAME box, within a
 * small epsilon (sub-pixel layout jitter between two genuinely-static reads
 * is possible; a real reflow moves by whole pixels). */
function sameRect(a: ActionableProbeResult['rect'], b: ActionableProbeResult['rect']): boolean {
  const EPS = 0.5;
  return Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS && Math.abs(a.width - b.width) < EPS && Math.abs(a.height - b.height) < EPS;
}

export class CdpBrowser implements BrowserPort {
  private client: CDP.Client | null = null;
  private tabId: string | null = null;
  private capture: CaptureBuffers | null = null;
  /** A4 (P0): per-tab network-idle tracker backing waitForIdle(). Attached
   * ONCE per client (here, or in openTab()) — same one-listener-set-per-client
   * discipline as `capture` (see its doc comment) and carried across
   * switchTab() alongside it. */
  private idle: ReturnType<typeof createNetworkIdleTracker> | null = null;
  /** planner nodeId ("n7") → CDP backendDOMNodeId; refreshed by every axTree(). */
  private nodeMap = new Map<string, number>();
  /** Tabs opened via openTab() (or stashed by switchTab() when we move away
   * from them) that are NOT the currently active session. Keyed by CDP target
   * id. `capture`/`idle` are attached EXACTLY ONCE per client (in openTab(), or
   * here when stashing the tab we're switching away from) and carried across
   * switches — re-attaching on every switchTab() would register a SECOND set
   * of Runtime.consoleAPICalled/Network.* listeners on the same client,
   * leaking duplicate console/network entries into later drains (and, for
   * `idle`, double-counting in-flight requests). */
  private otherTabs = new Map<string, { client: CDP.Client; capture: CaptureBuffers; idle: ReturnType<typeof createNetworkIdleTracker> }>();
  /** The tab launch() started with — switchTab(0)/replay's tabIndex 0 always
   * means "this one", regardless of how many tabs have been opened/switched
   * since. Never changes after launch(). */
  private mainTabId: string | null = null;
  /** ids in openTab() call order — switchTab(N) for N>=1 means "the Nth tab
   * openTab() created", the numeric convention recorded scripts replay with
   * (see recorder/script.ts's tabIndexFor / recorder/replay.ts). */
  private openOrder: string[] = [];
  /** A9 (P0): tabs the PAGE opened by itself (window.open / target="_blank"),
   * adopted by adoptPageTarget() and not yet handed to the driver. Drained by
   * takeNewTabs() exactly once each — see that method and BrowserPort's
   * doc comment. */
  private newTabs: NewTabInfo[] = [];
  /** A9 (P0): target ids adoptPageTarget() has already seen (adopted OR
   * rejected), so a repeated Target.attachedToTarget for the same popup never
   * opens a second client for it. */
  private seenTargets = new Set<string>();

  /** A49 (P2): set once `Inspector.targetCrashed` fires on the active tab (a
   * renderer crash — OOM, a native-code bug the page's own JS triggered, GPU
   * process death). Checked in the `c` getter below, which every single
   * BrowserPort primitive routes through — one flag check there means every
   * subsequent call (click/type/axTree/screenshot/…) fails IMMEDIATELY with a
   * clear message instead of hanging, or throwing an opaque "session closed"
   * CDP error, which is what actually happens against a crashed target.
   * loop.ts's own A6 crash-safety wrapper turns that throw into a persisted
   * `uncertain` report — this only needs to make the throw clear, not catch it. */
  private crashed: string | null = null;
  /** A49 (P2): periodic sweep of the active tab's stale network `pending`
   * entries — see STALE_PENDING_MAX_AGE_MS / CaptureBuffers.sweepStalePending's
   * doc comment. Started in launch(), stopped in close(). */
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  /** allowedHosts (A4, P0 defense-in-depth): hosts the driver may click/type
   * on, re-checked here independent of driver/loop.ts's own Tier-4 guard.
   * Omitted → no additional port-level restriction (see browser-port.ts's
   * DEFAULT_ALLOWED_HOSTS doc comment); pass the run's resolved allowedHosts
   * to actually enforce it here. */
  constructor(private readonly opts: LaunchOptions & { allowedHosts?: string[] }) {}

  private get c(): CDP.Client {
    // A49 (P2): fail every subsequent call clearly once the target has
    // crashed — see the `crashed` field's doc comment above for why this one
    // check covers the whole port.
    if (this.crashed) throw new Error(this.crashed);
    if (!this.client) throw new Error('CdpBrowser: launch() first');
    return this.client;
  }

  /** A4 (P0) defense-in-depth: re-checks the Tier-4 allowedHosts guard at the
   * port layer against the LIVE page host, independent of driver/loop.ts's own
   * check. Called before every mutating primitive (click/type/…) — navigate/
   * reload/goBack/hover/screenshot/axTree stay unrestricted, mirroring
   * loop.ts's MUTATING_ACTION_TYPES semantics exactly. No-ops when the caller
   * didn't pass allowedHosts (see browser-port.ts's DEFAULT_ALLOWED_HOSTS doc
   * comment for why this isn't defaulted to localhost-only automatically). */
  private async assertMutationAllowed(what: string): Promise<void> {
    if (!this.opts.allowedHosts) return;
    // A4 (P0): wrapped in withTimeout — this runs before EVERY mutating
    // primitive, so a page stuck in a synchronous JS loop (the exact bug
    // class this tool exists to catch) would otherwise wedge url()'s
    // Runtime.evaluate and, with it, the whole run, forever. A timeout here
    // throws, which the driver's per-action catch turns into a failed step,
    // not a crash.
    await withTimeout(
      (async () => {
        const host = hostOfUrl(await this.url());
        assertMutationHostAllowed(host, this.opts.allowedHosts!, what);
      })(),
      CDP_CALL_TIMEOUT_MS,
      `assertMutationAllowed(${what})`,
    );
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
    this.mainTabId = this.tabId;
    this.client = await CDP({ port: this.opts.port, target: this.tabId });
    await Promise.all([
      this.client.Page.enable(),
      this.client.Runtime.enable(),
      this.client.Debugger.enable(),
      this.client.DOM.enable(),
      this.client.Accessibility.enable(),
      this.client.Inspector.enable(),
    ]);
    // A49 (P2): a renderer crash on the main tab must abort the run with a
    // clear message rather than hang the next CDP call or surface an opaque
    // "session closed" error — see the `crashed` field's doc comment.
    this.client.Inspector.targetCrashed(() => {
      this.crashed = 'Chrome tab crashed (Inspector.targetCrashed) — the page is gone; aborting this run';
    });
    // A9 (P0): see the popup targets and then take them over. Without this the
    // port only ever knows about tabs IT opened, so a "Sign in with Google"
    // button — which is a plain window.open — created a page the driver could
    // never look at, click in, or switch to: every app behind an SSO login was
    // a dead end. Auto-attach reports those targets as they are created;
    // adoptPageTarget() turns each into an ordinary switchable tab.
    this.client.Target.attachedToTarget((ev: unknown) => {
      const info = (ev as { targetInfo?: { targetId?: string; type?: string; url?: string } }).targetInfo;
      if (!info?.targetId || info.type !== 'page') return; // iframes/workers are not tabs
      void this.adoptPageTarget(info.targetId, info.url ?? '');
    });
    // waitForDebuggerOnStart MUST stay false — true pauses every new page until
    // we explicitly resume it, which would freeze any popup the page opens.
    // flatten:true is the modern (non-deprecated) session model; we still open
    // a SEPARATE connection per adopted tab below, because the rest of this
    // class is built on one chrome-remote-interface client per tab.
    await this.client.Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {
      /* best-effort: an older/edge Chrome without page-session auto-attach
       * just means popups stay invisible — the driver falls back to telling
       * the user to sign in on the tab first (see driver/sso-popup.ts). */
    });
    // capture must attach before the first navigation so nothing is missed
    this.capture = await attachCapture(this.client);
    this.idle = createNetworkIdleTracker(this.client);
    // A49 (P2): periodic stale-pending-request sweep for the ACTIVE tab's
    // capture — deliberately reads `this.capture` on every tick (not the
    // reference captured here) so it always sweeps whichever tab is
    // currently active after a switchTab(), not just the tab launch() opened.
    this.sweepTimer = setInterval(() => {
      this.capture?.sweepStalePending(STALE_PENDING_MAX_AGE_MS);
    }, STALE_PENDING_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.(); // never keep the process alive on its own
  }

  /** A4 (P0): resolves once Network has been quiet for `networkQuietMs` (or
   * `timeoutMs` elapses) on the CURRENTLY active tab's tracker. `this.idle` is
   * only null before launch() — every mutating primitive already requires a
   * launched client, so this is a defensive no-op, not a real code path. */
  async waitForIdle(opts?: WaitForIdleOptions): Promise<void> {
    if (!this.idle) return;
    await this.idle.waitForIdle(opts);
  }

  async navigate(url: string): Promise<void> {
    const loaded = this.c.Page.loadEventFired();
    await this.c.Page.navigate({ url });
    await Promise.race([loaded, sleep(15_000)]);
    // A4 (P0): was a flat sleep(300) — now waits for the network to actually
    // go quiet (bounded), so a fast page moves on sooner and a slow one gets
    // real extra time instead of a guess.
    await this.waitForIdle();
  }

  async url(): Promise<string> {
    // A4 (P0): wrapped in withTimeout — a page stuck in a synchronous JS loop
    // can wedge this Runtime.evaluate call forever; throwing here (instead of
    // hanging) lets the driver's per-action catch classify it as a failed
    // step. Also called from assertMutationAllowed(), which has its own outer
    // timeout — the inner one here fires first in practice.
    return withTimeout(
      (async () => {
        const { result } = await this.c.Runtime.evaluate({ expression: 'location.href', returnByValue: true });
        return result.value as string;
      })(),
      CDP_CALL_TIMEOUT_MS,
      'url()',
    );
  }

  async axTree(opts?: AxTreeOptions): Promise<AxSnapshot> {
    const { snapshot, nodeMap } = await snapshotAxTree(this.c, opts);
    this.nodeMap = nodeMap;
    return snapshot;
  }

  /** See BrowserPort.peekAxTree — same snapshot, `nodeMap` deliberately left
   * bound to whatever the planner is currently reasoning about. */
  async peekAxTree(): Promise<AxSnapshot> {
    const { snapshot } = await snapshotAxTree(this.c);
    return snapshot;
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

  /** One synchronous read of ACTIONABLE_PROBE_JS on the node behind
   * `backendNodeId`, or null when the node can't be resolved right now
   * (detached, not yet attached). Wrapped in raceTimeout so a single wedged
   * CDP call (resolveNode/callFunctionOn) can never itself hang past 1s —
   * see raceTimeout's doc comment for the incident this guards against. */
  private async probeActionable(backendNodeId: number): Promise<ActionableProbeResult | null> {
    return raceTimeout(
      (async () => {
        let objectId: string | undefined;
        try {
          const { object } = await this.c.DOM.resolveNode({ backendNodeId }).catch(() => ({ object: undefined }) as { object?: { objectId?: string } });
          objectId = object?.objectId;
          if (!objectId) return null;
          const { result } = await this.c.Runtime.callFunctionOn({
            objectId,
            functionDeclaration: ACTIONABLE_PROBE_JS,
            returnByValue: true,
          });
          return (result?.value as ActionableProbeResult | undefined) ?? null;
        } catch {
          return null;
        } finally {
          if (objectId) await this.c.Runtime.releaseObject({ objectId }).catch(() => {});
        }
      })(),
      1000,
      null,
    );
  }

  /** A4 (P0): Playwright-style actionability wait — attached, visible,
   * enabled, and stable across two consecutive samples (see
   * ACTIONABLE_PROBE_JS / probeActionable — deliberately NOT in-page
   * `requestAnimationFrame`, see ACTIONABLE_PROBE_JS's doc comment for the
   * real hang that caused this to be rewritten). Throws — not a silent
   * timeout — because an element the AX tree resolved by role+name that
   * never becomes actionable (hidden behind a modal, disabled pending
   * another action, still animating) is real signal a caller should see,
   * distinct from "not found at all". */
  async waitForActionable(nodeId: string, opts?: WaitForActionableOptions): Promise<void> {
    const timeoutMs = opts?.timeoutMs ?? 5000;
    const deadline = Date.now() + timeoutMs;
    const backendNodeId = this.backendNodeId(nodeId);
    let lastRect: ActionableProbeResult['rect'] | null = null;
    for (;;) {
      const probe = await this.probeActionable(backendNodeId);
      if (probe?.visible && probe.enabled) {
        if (lastRect && sameRect(lastRect, probe.rect)) return;
        lastRect = probe.rect;
      } else {
        lastRect = null;
      }
      if (Date.now() > deadline) {
        throw new Error(`waitForActionable(${nodeId}): not actionable (attached/visible/enabled/stable) after ${timeoutMs}ms`);
      }
      // Node-side gap between consecutive stability samples (~2 frames at
      // 60fps) — this is what makes the stability check "two consecutive
      // reads" meaningful without depending on the page's own paint timing.
      await sleep(32);
    }
  }

  async click(nodeId: string): Promise<void> {
    await this.assertMutationAllowed('click');
    const backendNodeId = this.backendNodeId(nodeId);
    const { x, y } = await this.centerOf(backendNodeId);
    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await this.c.Input.dispatchMouseEvent({ type, x, y, button: 'left', clickCount: 1 });
    }
    // A4 (P0): was a flat sleep(400) — a click can kick off anything from a
    // synchronous class toggle to a full navigation; waitForIdle covers both
    // (floor-only when nothing fires, up to the bound when it does).
    await this.waitForIdle({ networkQuietMs: 200, timeoutMs: 3000 });
  }

  async type(nodeId: string, text: string): Promise<void> {
    await this.assertMutationAllowed('type');
    const backendNodeId = this.backendNodeId(nodeId);
    await this.c.DOM.focus({ backendNodeId });
    // Select all existing content first so insertText REPLACES rather than
    // appends at the caret (a filled field would otherwise concatenate, e.g.
    // "a@b.coma@b.co"). Selection is done at the DOM level — see selectAllIn()
    // for why the previous Ctrl+A key-event approach was macOS-broken.
    await this.selectAllIn(backendNodeId);
    // Input.insertText keeps the text out of key-event listeners — this is also
    // the future credential-vault path (the model never sees what gets typed).
    // It replaces the current selection (set just above), giving the replace
    // semantics the planner prompt promises.
    await this.c.Input.insertText({ text });
    // A4 (P0): was a flat sleep(150); a controlled-input onChange can fire an
    // API call (autosave, validation) that the caller's next axTree() should
    // see settled.
    await this.waitForIdle({ networkQuietMs: 150, timeoutMs: 1500 });

    // ALWAYS verify the value actually landed. insertText satisfies React 18
    // controlled inputs (it dispatches beforeinput/input like IME insertion —
    // proven by test/v18.react-typing.ts), but rarer inputs (some masked /
    // heavily-controlled widgets) can swallow it. One cheap read closes the
    // silent-typing-failure bug class for good; the slow per-char path only
    // engages on a real mismatch.
    await this.verifyTyped(backendNodeId, text);
  }

  async hover(nodeId: string): Promise<void> {
    const backendNodeId = this.backendNodeId(nodeId);
    const { x, y } = await this.centerOf(backendNodeId);
    await this.c.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
    // A4 (P0): was a flat sleep(250) — hover-triggered UI (tooltips, menus) is
    // almost always synchronous CSS/JS, so this mostly resolves at the floor;
    // the bound stays generous in case it fires a lazy-load fetch.
    await this.waitForIdle({ networkQuietMs: 150, timeoutMs: 1000 });
  }

  async pressKey(key: string): Promise<void> {
    await this.assertMutationAllowed('pressKey');
    await this.c.Page.bringToFront().catch(() => {});
    await this.c.Input.dispatchKeyEvent({ type: 'keyDown', key });
    await this.c.Input.dispatchKeyEvent({ type: 'keyUp', key });
    // A4 (P0): was a flat sleep(150) — a key press can submit a form.
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
    // A4 (P0): was a flat sleep(200) — a `select` firing `change` is a common
    // dependent-dropdown/autosave trigger.
    await this.waitForIdle({ networkQuietMs: 200, timeoutMs: 2000 });
  }

  async reload(): Promise<void> {
    const loaded = this.c.Page.loadEventFired();
    await this.c.Page.reload({ ignoreCache: false });
    await Promise.race([loaded, sleep(15_000)]);
    // A4 (P0): was a flat sleep(300) — same reasoning as navigate().
    await this.waitForIdle();
  }

  async goBack(): Promise<void> {
    const { entries, currentIndex } = await this.c.Page.getNavigationHistory();
    if (currentIndex <= 0) throw new Error('goBack() failed: no previous history entry');
    const loaded = this.c.Page.loadEventFired();
    await this.c.Page.navigateToHistoryEntry({ entryId: entries[currentIndex - 1].id });
    await Promise.race([loaded, sleep(15_000)]);
    // A4 (P0): was a flat sleep(300) — same reasoning as navigate().
    await this.waitForIdle();
  }

  async uploadFile(nodeId: string, paths: string[]): Promise<void> {
    await this.assertMutationAllowed('uploadFile');
    const backendNodeId = this.backendNodeId(nodeId);
    await this.c.DOM.setFileInputFiles({ files: paths, backendNodeId });
    // A4 (P0): was a flat sleep(150) — a file input's `change` handler often
    // kicks off an immediate upload request.
    await this.waitForIdle({ networkQuietMs: 200, timeoutMs: 2000 });
  }

  async dragAndDrop(sourceId: string, targetId: string): Promise<void> {
    await this.assertMutationAllowed('dragAndDrop');
    const src = await this.centerOf(this.backendNodeId(sourceId));
    const dst = await this.centerOf(this.backendNodeId(targetId));
    await this.c.Input.dispatchMouseEvent({ type: 'mouseMoved', x: src.x, y: src.y });
    await this.c.Input.dispatchMouseEvent({ type: 'mousePressed', x: src.x, y: src.y, button: 'left', clickCount: 1 });
    // Move in a few steps so listeners bound to mousemove (custom sortables,
    // sliders, drop-zone highlight logic) see intermediate positions, not a
    // single teleport from source to target.
    // A4 (P0): the 30ms-per-step pacing here is DELIBERATELY KEPT, not a
    // settle-wait — it is not "wait for the page to react", it's "simulate a
    // real per-frame mouse glide" so libraries that gate drag-detection on
    // mousemove timing (sortable lists, custom drop zones) see a plausible
    // gesture instead of a teleport. waitForIdle has nothing to condition on
    // here (there's no page reaction to wait for mid-gesture), so this one
    // stays a fixed sleep on purpose.
    const STEPS = 6;
    for (let i = 1; i <= STEPS; i++) {
      const x = src.x + ((dst.x - src.x) * i) / STEPS;
      const y = src.y + ((dst.y - src.y) * i) / STEPS;
      await this.c.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y, button: 'left' });
      await sleep(30);
    }
    await this.c.Input.dispatchMouseEvent({ type: 'mouseReleased', x: dst.x, y: dst.y, button: 'left', clickCount: 1 });
    // A4 (P0): the TRAILING sleep(200) — after release, the drop handler runs
    // — is the one that's actually waiting for the page, so it converts.
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
    // A4 (P0): was a flat sleep(100) — blur commonly triggers field validation.
    await this.waitForIdle({ networkQuietMs: 100, timeoutMs: 800 });
  }

  async mouse(kind: 'move' | 'down' | 'up', x: number, y: number): Promise<void> {
    // loop.ts's MUTATING_ACTION_TYPES treats 'mouse' as one mutating action
    // type regardless of kind (only hover() is the read-only primitive) — match
    // that exactly rather than special-casing 'move' here.
    await this.assertMutationAllowed('mouse');
    await this.c.Page.bringToFront().catch(() => {});
    const type = kind === 'move' ? 'mouseMoved' : kind === 'down' ? 'mousePressed' : 'mouseReleased';
    await this.c.Input.dispatchMouseEvent({ type, x, y, button: 'left', clickCount: 1 });
    // A4 (P0): was a flat sleep(50/150) — 'move' rarely triggers network, 'down'/
    // 'up' can (custom drag-drop save, canvas interaction endpoints).
    await this.waitForIdle({ networkQuietMs: 100, timeoutMs: kind === 'move' ? 500 : 1000 });
  }

  async openTab(url: string): Promise<string> {
    const target = await CDP.New({ port: this.opts.port, url });
    const id = (target as { id?: string }).id ?? (target as { targetId?: string }).targetId!;
    const client = await CDP({ port: this.opts.port, target: id });
    await Promise.all([
      client.Page.enable(),
      client.Runtime.enable(),
      client.Debugger.enable(),
      client.DOM.enable(),
      client.Accessibility.enable(),
    ]);
    // capture/idle attach ONCE here and travel with this client across
    // switches (see the otherTabs doc comment) — never re-attached in switchTab().
    const capture = await attachCapture(client);
    const idle = createNetworkIdleTracker(client);
    this.otherTabs.set(id, { client, capture, idle });
    this.openOrder.push(id);
    return id;
  }

  /** A9 (P0): adopt a page target this port did not open — a popup or a
   * `target="_blank"` tab — so switchTab() can reach it like any openTab() tab.
   * Attaches its own client + capture/idle ONCE, exactly as openTab() does (see
   * the otherTabs doc comment for why re-attaching on switch would leak
   * duplicate listeners).
   *
   * Deliberately NOT pushed onto `openOrder`: that list defines the numeric
   * replay convention ("the Nth tab openTab() created"), and a popup the page
   * happened to open is not an openTab() call — inserting it would silently
   * renumber every recorded switch_tab. Adopted tabs are referenced by their
   * literal id, which switchTab() already accepts.
   *
   * Idempotent: every id is considered once, so a duplicate
   * Target.attachedToTarget (or a list sweep that sees the same popup again)
   * can never open a second client for the same tab. */
  private async adoptPageTarget(id: string, url: string): Promise<void> {
    if (!this.client) return; // not launched yet (or already closed)
    if (id === this.tabId || id === this.mainTabId) return;
    if (this.otherTabs.has(id) || this.seenTargets.has(id)) return;
    this.seenTargets.add(id);
    try {
      const client = await CDP({ port: this.opts.port, target: id });
      await Promise.all([
        client.Page.enable(),
        client.Runtime.enable(),
        client.Debugger.enable(),
        client.DOM.enable(),
        client.Accessibility.enable(),
      ]);
      const capture = await attachCapture(client);
      const idle = createNetworkIdleTracker(client);
      this.otherTabs.set(id, { client, capture, idle });
      this.newTabs.push({ id, url });
    } catch {
      // the popup closed itself before we got there, or the target refuses a
      // second client — forget it so a later sweep may retry.
      this.seenTargets.delete(id);
    }
  }

  /** A9 (P0): see BrowserPort.takeNewTabs. Sweeps the browser's target list as
   * well as draining what Target.attachedToTarget already adopted — auto-attach
   * on a page session covers the related-target cases, and the sweep catches
   * anything it doesn't (an older Chrome, or a tab opened from a frame), using
   * the same local HTTP endpoint openTab() already talks to. */
  async takeNewTabs(): Promise<NewTabInfo[]> {
    if (this.client) {
      try {
        const targets = (await CDP.List({ port: this.opts.port })) as Array<{ id?: string; targetId?: string; type?: string; url?: string }>;
        for (const t of targets) {
          if (t.type !== 'page') continue;
          const id = t.id ?? t.targetId;
          if (id) await this.adoptPageTarget(id, t.url ?? '');
        }
      } catch {
        /* best-effort discovery — auto-attach is the primary path */
      }
    }
    const drained = this.newTabs;
    this.newTabs = [];
    return drained;
  }

  /** idOrIndex accepts either the literal id openTab() returned (what the live
   * navigator references — see history text) OR the numeric replay convention
   * a recorded script uses: 0 = the tab launch() started with, N (>=1) = the
   * Nth tab openTab() created (creation order) — see recorder/script.ts's
   * tabIndexFor. A raw runtime id would not exist on a later replay run;
   * the numeric form is what actually survives. */
  private resolveTabIndex(idOrIndex: string | number): string {
    if (typeof idOrIndex === 'string') return idOrIndex;
    if (idOrIndex === 0) {
      if (!this.mainTabId) throw new Error('switchTab(0): no main tab recorded (launch() first)');
      return this.mainTabId;
    }
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
    // Stash the currently active tab (client + its ALREADY-attached capture/
    // idle — never re-attach) so it stays reachable for a later switchTab().
    if (this.tabId && this.client && this.capture && this.idle) {
      this.otherTabs.set(this.tabId, { client: this.client, capture: this.capture, idle: this.idle });
    }
    this.otherTabs.delete(targetId);
    this.client = target.client;
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
      await target.client.close().catch(() => {});
      this.otherTabs.delete(id);
    }
    await CDP.Close({ port: this.opts.port, id }).catch(() => {});
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

  /** Select the whole field's content at the DOM level, so a following
   * Input.insertText REPLACES rather than appends.
   *
   * Was a synthetic Ctrl+A key event (`modifiers: 2`). That is select-all on
   * Windows/Linux only — on macOS select-all is Cmd+A (`modifiers: 4`) and
   * Ctrl+A is move-to-line-start, so nothing was ever selected and every type()
   * into a NON-EMPTY field silently appended ("WRONG" + "SAVE10"). The e2e
   * suites never caught it because the fixture's fields start empty, where
   * append and replace are indistinguishable; test/m1.browser-port.ts types
   * over a pre-filled field and has been failing on macOS since.
   *
   * Doing the selection through the DOM sidesteps the platform question
   * entirely — no modifier to get right, and it covers contenteditable too,
   * which no Ctrl/Cmd+A dispatch would have handled uniformly either. */
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

  /** Confirm insertText took; if not, fall back to per-character key events
   * (the slow-but-bulletproof path) and re-verify, throwing on a hard failure.
   *
   * A4 (P0): this POLLS rather than reading once. The single read was safe only
   * because a flat sleep(150) preceded it; once that became waitForIdle(), a
   * network-quiet page legitimately returns after the 50ms floor (the quiet
   * window measures time since the last NETWORK event, and a page idle for
   * seconds already satisfies it). A React-controlled input can still be
   * mid-commit at that point, so the one-shot read saw a stale value and
   * triggered the per-character fallback ON TOP of text that had in fact
   * landed — producing doubled input ("SSAAVVEE1100"), caught by
   * test/m1.browser-port.ts. Polling is also strictly better than the old
   * sleep: a fast input proceeds in ~0ms instead of always paying 150ms, and a
   * slow one gets up to 600ms instead of failing at 150ms. */
  private async verifyTyped(backendNodeId: number, expected: string): Promise<void> {
    const deadline = Date.now() + 600;
    for (;;) {
      if ((await this.liveValue(backendNodeId)) === expected) return;
      if (Date.now() >= deadline) break;
      await sleep(40);
    }
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

  /** Per-character fallback: select-all, then dispatch rawKeyDown/char/keyUp for
   * every character so even inputs that ignore insertText receive real key
   * events. Slow but bulletproof.
   *
   * rawKeyDown (NOT keyDown) is deliberate: a `keyDown` carrying `text` ALREADY
   * inserts the character, so pairing it with a `char` event inserted every
   * character TWICE ("SAVE10" → "SSAAVVEE1100"). rawKeyDown fires the key
   * without inserting, leaving `char` as the single insertion point — while
   * still delivering a real keydown to listeners, which is the whole reason
   * this fallback exists. */
  private async typeByKeyEvents(backendNodeId: number, text: string): Promise<void> {
    await this.c.DOM.focus({ backendNodeId });
    await this.selectAllIn(backendNodeId);
    // Replace the now-selected content with the first keystroke onward.
    for (const ch of text) {
      await this.c.Input.dispatchKeyEvent({ type: 'rawKeyDown', key: ch, unmodifiedText: ch });
      await this.c.Input.dispatchKeyEvent({ type: 'char', text: ch, unmodifiedText: ch, key: ch });
      await this.c.Input.dispatchKeyEvent({ type: 'keyUp', key: ch });
    }
    // A4 (P0): was a flat sleep(100) — mirrors type()'s reasoning.
    await this.waitForIdle({ networkQuietMs: 150, timeoutMs: 1500 });
  }

  /** Stamp a generated `data-qa-id` on the node and return the id (#9). Resolves
   * the snapshot backendNodeId → JS object, sets the attribute via
   * callFunctionOn, releases the object. Returns null if the node can't be
   * resolved. The id is short + random — stable for THIS page instance only
   * (attributes don't survive reloads, which is the documented caveat). */
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

  /** Find a node in the CURRENT page by stamped `data-qa-id` and return a nodeId
   * usable with click()/type() (#9). Registers the match's backendNodeId into the
   * live nodeMap under a synthetic `qa:<id>` key (so click(nodeId) resolves) and
   * returns that key. Returns null when the attribute isn't present (e.g. lost on
   * a reload) — replay then keeps its precise role+name errors. */
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

  /** A8 (P1) live fallback for BrowserPort.findByTestId: the COMMON path
   * resolves a testid straight out of the already-fetched AxSnapshot
   * (`AxNode.testId`, populated once per snapshot in axtree.ts with no extra
   * round-trip) — this method only runs when that misses (element rendered
   * after the snapshot was taken, or pruned for an unrelated reason). Tries
   * each attribute in TESTID_ATTRS in priority order (same list, same order,
   * as the snapshot capture — see its doc comment) and returns on the first
   * match; querying attributes one at a time (rather than one grouped CSS
   * selector) is what lets `data-testid` win over `data-qa` on a page that
   * happens to carry both, matching the snapshot's own priority. */
  async findByTestId(testId: string): Promise<string | null> {
    try {
      const { root } = await this.c.DOM.getDocument({ depth: 0 });
      const escaped = testId.replace(/"/g, '\\"');
      for (const attr of TESTID_ATTRS) {
        const { nodeId: domNodeId } = await this.c.DOM.querySelector({ nodeId: root.nodeId, selector: `[${attr}="${escaped}"]` });
        if (!domNodeId) continue;
        const { node } = await this.c.DOM.describeNode({ nodeId: domNodeId });
        const backendNodeId = node.backendNodeId;
        if (backendNodeId === undefined) continue;
        const synthetic = `testid:${testId}`;
        this.nodeMap.set(synthetic, backendNodeId);
        return synthetic;
      }
      return null;
    } catch {
      return null;
    }
  }

  async screenshot(): Promise<Buffer> {
    const { data } = await this.c.Page.captureScreenshot({ format: 'png' });
    return Buffer.from(data, 'base64');
  }

  /** A24 Tier-0 oracle. Evaluates the ONE compile-time constant probe — never
   * caller-supplied JS (see BrowserPort.probeInvariants). The probe is itself
   * try/catch-wrapped in-page, so a hostile or half-loaded document yields a
   * junk-but-harmless value rather than throwing; invariants.ts parses any
   * shape defensively. */
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

  async close(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const [id, tab] of this.otherTabs) {
      try { await tab.client.close(); } catch { /* already closed */ }
      try { await CDP.Close({ port: this.opts.port, id }); } catch { /* gone */ }
    }
    this.otherTabs.clear();
    if (!this.client) return;
    try { await this.client.close(); } catch { /* already closed */ }
    if (this.tabId) {
      try { await CDP.Close({ port: this.opts.port, id: this.tabId }); } catch { /* gone */ }
    }
    this.client = null;
    this.tabId = null;
    this.mainTabId = null;
    this.openOrder = [];
    this.newTabs = [];
    this.seenTargets.clear();
    this.capture = null;
    this.idle = null;
    this.nodeMap.clear();
    this.crashed = null;
  }
}
