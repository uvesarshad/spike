/* BrowserPort — the seam between the engine and whatever drives Chrome.
 * CdpBrowser (plain CDP, --remote-debugging-port) is the MVP implementation;
 * ExtensionBrowser (MV3 chrome.debugger) implements the same contract in the
 * vibe-mode milestone. The engine must only ever import this interface. */

import type CDP from 'chrome-remote-interface';

export interface AxNode {
  /** Per-snapshot stable id the planner references in actions (e.g. "n7"). */
  id: string;
  role: string;
  name?: string;
  value?: string;
  /** Notable states: disabled, focused, required, checked… */
  states?: string[];
  /** A8 (P1): the node's `data-testid` (or `data-test-id`/`data-test`/`data-qa`
   * alias, first one present wins in that priority order) — captured once per
   * snapshot in axtree.ts's `snapshotAxTree()` via a single bulk DOM fetch, so
   * it costs ZERO additional CDP round-trips beyond the snapshot every step
   * already takes. This is what lets the recorder/replay resolve a target by
   * testid straight out of the in-memory tree, no live DOM query needed on the
   * common path (BrowserPort.findByTestId is the live fallback for the
   * uncommon one — see its doc comment). A node that carries a test attribute
   * is ALSO kept by the AX pruning in axtree.ts even when it would otherwise
   * collapse (no accessible name, a generic/presentation role) — the exact
   * canvas/SVG/charting-widget case the A8 finding calls out as having no
   * accessible name at all. */
  testId?: string;
  children?: AxNode[];
}

/** A32: options forwarded to the AX serializer (see capture/axtree.ts's
 * SerializeAxTreeOptions — mirrored here so BrowserPort stays free of a
 * capture-layer import). */
export interface AxTreeOptions {
  focus?: { id?: string; role?: string; name?: string };
  maxChars?: number;
}

export interface AxSnapshot {
  root: AxNode;
  /** Compact indented text handed to the planner (~800 tokens target). */
  text: string;
  /** True when the serialization was truncated to fit the token guard. */
  truncated: boolean;
}

export interface ConsoleEntry {
  ts: number;
  /** log | info | warn | error | page-error */
  level: string;
  text: string;
}

export interface NetworkEntry {
  ts: number;
  method: string;
  url: string;
  status?: number;
  ms?: number;
  /** Hard failure: a 5xx response or a transport-level loadingFailed. Drives the
   * loop's batch-abort and firstError() priority — deliberately NOT widened to
   * 4xx (see clientError). */
  failed?: boolean;
  /** A18: 4xx response. Kept SEPARATE from `failed` because a 401 auth probe, a
   * 404 favicon, or a third-party analytics 4xx are all normal — widening
   * `failed` would change run outcomes. This flag exists so the navigator/brain
   * prompt and the Tier-0 invariant oracle can see client errors and weigh them
   * per-origin, rather than them being filtered out before the model ever
   * looks (which was the pre-A18 behaviour). */
  clientError?: boolean;
  errorText?: string;
}

export interface LogpointSpec {
  /** Script URL the logpoint targets. */
  url: string;
  /** Line located by content, never by hardcoded number. */
  lineContains: string;
  /** Expression whose value gets console.log'd (variables in scope at that line). */
  expression: string;
}

/** Mirrors driver/loop.ts's own default allowedHosts — for callers that want
 * to construct a port with the restrictive default explicitly. NOT applied
 * automatically when a port's `allowedHosts` option is omitted: engine.ts
 * constructs CdpBrowser/ExtensionBrowser before it resolves the run's actual
 * allowedHosts (loop.ts's own Tier-4 default/trustTargetHost widening), so
 * defaulting the port to localhost-only here would silently break every
 * non-localhost QA run. Omitted `allowedHosts` therefore means "no additional
 * port-layer restriction" (unchanged prior behavior) until callers are
 * updated to thread the resolved list through. */
export const DEFAULT_ALLOWED_HOSTS: string[] = ['localhost', '127.0.0.1'];

/** Host of a URL, lowercased; '' for unparseable/non-http urls (about:blank
 * etc). Mirrors driver/loop.ts's hostOf(). */
export function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** A45 (P2): matching rules for one `allowedHosts` entry against a live host —
 * exact host or its `www.` sibling ONLY, unless the entry opts into
 * subdomain-suffix matching by starting with a literal `.` (e.g.
 * `.example.com` trusts `anything.example.com`). Before this, a bare
 * `example.com` entry silently trusted EVERY subdomain — correct for a domain
 * you own outright, but wrong for a multi-tenant host (`*.vercel.app`,
 * `*.myshopify.com` siblings), where `evil.example.com` (someone else's
 * tenant) got the same click/type trust as the intended target. The
 * apex↔www pair (`mapleandsand.com` ↔ `www.mapleandsand.com`) — the one case
 * real sites need without opting in — stays covered by the plain-entry path;
 * broader subdomain trust is now an explicit, deliberate `.`-prefixed entry. */
function oneHostAllowed(rawHost: string, allowed: string): boolean {
  // Lowercase both sides — callers normally already hand this a lowercased
  // host (hostOfUrl() below always lowercases), but comparing case-sensitively
  // here would make correctness depend on every caller getting that right.
  const host = rawHost.toLowerCase();
  if (allowed.startsWith('.')) {
    const suffix = allowed.toLowerCase();
    const bare = suffix.slice(1);
    return host === bare || host.endsWith(suffix);
  }
  const a = allowed.toLowerCase();
  return host === a || host === `www.${a}` || `www.${host}` === a;
}

/** True when host matches an `allowedHosts` entry per `oneHostAllowed` above.
 * Mirrors driver/loop.ts's hostAllowed() so both layers of the Tier-4 guard
 * (A4) agree on what "allowed" means. */
export function isHostAllowed(host: string, allowedHosts: string[]): boolean {
  return allowedHosts.some((allowed) => oneHostAllowed(host, allowed));
}

/** A4 (P0) defense-in-depth: the port-layer half of the Tier-4 mutation guard.
 * driver/loop.ts already re-checks browser.url() before every mutating action
 * (click/type/…), but that check lives ONLY in the loop — a caller driving a
 * BrowserPort directly (or a raw CDP passthrough on the extension side, see
 * extension/sw.js) bypasses it entirely. Ports call this before mutating
 * calls so the guard holds even outside the loop. `allowedHosts` undefined
 * means the caller didn't opt in to port-level enforcement — no-op, matching
 * prior behavior (see DEFAULT_ALLOWED_HOSTS's doc comment for why this isn't
 * defaulted automatically). Throws (never silently no-ops once a list IS
 * given) so a blocked mutation surfaces as a clear step failure. */
export function assertMutationHostAllowed(host: string, allowedHosts: string[] | undefined, what: string): void {
  if (allowedHosts === undefined) return;
  if (host && !isHostAllowed(host, allowedHosts)) {
    throw new Error(`${what}: host "${host}" is not in allowedHosts — refusing to mutate`);
  }
}

/** A4 (P0): options for BrowserPort.waitForIdle. */
export interface WaitForIdleOptions {
  /** How long the network must have had ZERO in-flight requests before we call
   * it idle. Default 350ms — enough to catch a same-tick chained request (a
   * click handler that fires two sequential fetches) without paying a full
   * extra round-trip's worth of waiting on every step. */
  networkQuietMs?: number;
  /** Hard cap — waitForIdle NEVER waits unboundedly. A page with a legitimate
   * background poller/SSE stream/websocket keepalive would otherwise never go
   * quiet, turning one missing settle into a hung run. Default 5000ms. */
  timeoutMs?: number;
}

/** A4 (P0): options for BrowserPort.waitForActionable. */
export interface WaitForActionableOptions {
  /** Hard cap — default 5000ms, deliberately matching recorder/replay.ts's
   * existing FIND_TIMEOUT_MS so "found in the AX tree but never actionable"
   * and "never found at all" fail on the same budget. */
  timeoutMs?: number;
}

/** Minimal shape createNetworkIdleTracker needs off a CDP-shaped client — both
 * CdpBrowser's real `chrome-remote-interface` client and ExtensionBrowser's
 * bridge/cdp-shim.ts Proxy satisfy this (both are typed `CDP.Client`). */
type NetworkEventClient = Pick<CDP.Client['Network'], 'requestWillBeSent' | 'loadingFinished' | 'loadingFailed'>;

/** A4 (P0) — the missing primitive the audit calls out by name: "no
 * non-destructive in-flight/idle check to poll" (the exact acknowledgement
 * that used to sit at recorder/replay.ts:212-214). This tracks in-flight
 * Network requests over a CDP-shaped client so `waitForIdle()` can resolve on
 * an actual network-quiet CONDITION instead of a fixed sleep — the sleep was
 * simultaneously too slow (burning ~1.15s per 3-action batch, see the audit)
 * and too fast (not enough on a slow page, which is where flake comes from).
 *
 * Shared by CdpBrowser AND ExtensionBrowser: both expose the identical
 * `CDP.Client` shape (the latter via bridge/cdp-shim.ts's Proxy over
 * chrome.debugger — `buildCdpClient()` there literally types its return value
 * as `CDP.Client`), and chrome-remote-interface's event registration is a
 * plain Set of handlers per method name (confirmed by reading cdp-shim.ts's
 * `eventHandlers` map: `.add()`, never a single-slot assignment) — so wiring a
 * SECOND set of Network.* listeners here does NOT displace the ones
 * capture/console-network.ts's `attachCapture()` already registered on the
 * same client; both fire independently on every event. This tracker never
 * calls drainConsole()/drainNetwork() and keeps its own independent
 * bookkeeping, so it stays non-destructive to the step-record evidence those
 * buffers still feed — that non-destructiveness is exactly why the audit
 * flagged this as a real gap rather than "just drain the network buffer".
 *
 * Deliberately a Set of active requestIds rather than a bare +1/-1 counter: a
 * `loadingFinished`/`loadingFailed` for a requestId we never saw
 * `requestWillBeSent` for (a request that was already in flight before this
 * tracker attached, or a duplicate/out-of-order CDP event) must be a harmless
 * no-op — never allowed to drive a bare counter negative and wedge future
 * idle checks. */
export function createNetworkIdleTracker(client: { Network: NetworkEventClient }): {
  /** Current in-flight request count — exposed for tests/diagnostics. */
  inFlightCount(): number;
  /** Resolves once the network has been quiet for `networkQuietMs`, or after
   * `timeoutMs` elapses — whichever comes first. NEVER rejects: timing out
   * just means "proceed anyway", which is no worse than the fixed sleep this
   * replaces (that had no idea whether the page was actually settled either). */
  waitForIdle(opts?: WaitForIdleOptions): Promise<void>;
} {
  const active = new Set<string>();
  let lastActivityTs = Date.now();

  client.Network.requestWillBeSent((p) => {
    const requestId = (p as { requestId?: string }).requestId;
    if (!requestId) return;
    active.add(requestId);
    lastActivityTs = Date.now();
  });
  const settle = (p: unknown): void => {
    const requestId = (p as { requestId?: string }).requestId;
    // .delete() returns false for an unmatched id — exactly the "no-op" case
    // documented above; only a request we were actually tracking resets the
    // clock (an unmatched settle event is not evidence the PAGE just did
    // anything).
    if (requestId && active.delete(requestId)) lastActivityTs = Date.now();
  };
  client.Network.loadingFinished(settle);
  client.Network.loadingFailed(settle);

  // Small unconditional floor before the FIRST idle check: several call sites
  // this backs (blur, pressKey, mouse) are pure synchronous DOM work with no
  // network at all — for those, an immediate idle check would return on the
  // same tick and skip the one thing the OLD fixed sleep actually bought:
  // giving a synchronous event handler (a React state update, a bound
  // listener) one microtask/task turn to run before the caller reads the page.
  const FLOOR_MS = 50;
  const POLL_MS = 50;

  async function waitForIdle(opts: WaitForIdleOptions = {}): Promise<void> {
    const quietMs = opts.networkQuietMs ?? 350;
    const timeoutMs = opts.timeoutMs ?? 5000;
    const startTs = Date.now();
    const deadline = startTs + timeoutMs;
    await new Promise<void>((r) => setTimeout(r, Math.min(FLOOR_MS, timeoutMs)));
    for (;;) {
      const now = Date.now();
      // Quiet is measured from the later of "last network activity" and "when
      // we STARTED waiting" — not from lastActivityTs alone.
      //
      // Measuring from lastActivityTs alone made this return after only
      // FLOOR_MS on any page that had been network-quiet for a while: the
      // condition `now - lastActivityTs >= quietMs` was ALREADY satisfied on
      // entry by seconds of prior idleness. That is the wrong question. The
      // caller has just dispatched a click/keypress and wants to know whether
      // it triggered network work — but an XHR takes longer than 50ms merely to
      // be ISSUED, so we returned before the request existed, saw a stale page,
      // and the navigator clicked "Sign in" a second time (recorded into a
      // script that then failed on replay, since a logged-in page has no
      // "Sign in" button). Anchoring on startTs gives any handler a full
      // quiet-window to kick off work; if it does, `lastActivityTs` moves and
      // the window restarts, so a slow page still gets the full timeout.
      const quietSince = Math.max(lastActivityTs, startTs);
      if (active.size === 0 && now - quietSince >= quietMs) return;
      if (now >= deadline) return; // hard cap — never an unbounded wait
      await new Promise<void>((r) => setTimeout(r, Math.min(POLL_MS, deadline - now)));
    }
  }

  return { inFlightCount: () => active.size, waitForIdle };
}

/** A4 (P0) safety net for waitForActionable: races a single CDP call against a
 * short local timeout so ONE wedged call can never block a poll loop's own
 * deadline check indefinitely. This was added after a real hang: the first
 * cut of the actionability probe used in-page `requestAnimationFrame` inside
 * a `Runtime.callFunctionOn({ awaitPromise: true })` call — rAF callbacks are
 * throttled/paused by Chromium for a tab that isn't the OS-foreground tab
 * (e.g. another `Page.bringToFront()` call, from a concurrent run driving a
 * different tab in the same shared browser, stole focus), so the CDP call
 * itself never returned and NOTHING in the loop ever got to check
 * `Date.now() > deadline` — it was stuck inside one unresolvable `await`.
 * The probe itself no longer depends on rAF (see cdp-browser.ts's
 * ACTIONABLE_PROBE_JS), but every CDP round-trip in a poll loop is still
 * wrapped in this as defense in depth against a wedged call from any cause.
 * Returns `fallback` instead of hanging; does NOT swallow a rejection that
 * arrives before the timeout — only a call that neither resolves nor rejects
 * in time is affected. */
export function raceTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

export interface BrowserPort {
  launch(): Promise<void>;
  navigate(url: string): Promise<void>;
  url(): Promise<string>;
  /** Snapshot the accessibility tree; refreshes the nodeId map used by click/type.
   *
   * A32: `opts` optionally focuses the serialization on one region (A19). With
   * no opts the output is byte-identical to before — every existing caller is
   * unaffected. Implementations that cannot honour a focus hint may ignore it;
   * the hint is an optimisation, never a correctness requirement. */
  axTree(opts?: AxTreeOptions): Promise<AxSnapshot>;
  /** Snapshot WITHOUT rebinding the planner's `n7`-style ids.
   *
   * `axTree()` deliberately remaps ids on every call, because the planner
   * always reasons about the snapshot it was just handed. But an observer that
   * only wants to LOOK at the page — the action cache capturing before/after
   * effect state — must not remap: the driver plans a batch of up to 3 actions
   * against ONE snapshot, so a remap between them silently repoints the
   * remaining ids at a newer tree. That is a real bug this guards against, not
   * a hypothetical: with the cache enabled, `[type n5, type n7, click n8]`
   * re-snapshotted before the click and `n8` no longer meant the button the
   * navigator had chosen. Optional — callers fall back to `axTree()`. */
  peekAxTree?(): Promise<AxSnapshot>;
  click(nodeId: string): Promise<void>;
  type(nodeId: string, text: string): Promise<void>;
  hover(nodeId: string): Promise<void>;
  pressKey(key: string): Promise<void>;
  selectOption(nodeId: string, value: string): Promise<void>;
  reload(): Promise<void>;
  goBack(): Promise<void>;
  /** Set the files on a native `<input type="file">` behind `nodeId`. Paths are
   * whatever the caller resolved them to (recorded scripts keep them relative —
   * see recorder/script.ts); the driver never invents or embeds secrets here. */
  uploadFile(nodeId: string, paths: string[]): Promise<void>;
  /** Press on `sourceId`'s center, glide to `targetId`'s center, release —
   * drives mouse-event-based drag interactions (sortable lists, sliders,
   * custom drop zones). Native HTML5 `draggable` drag/drop (which needs an OS
   * drag gesture, not just mouse events) is out of scope. */
  dragAndDrop(sourceId: string, targetId: string): Promise<void>;
  /** Remove focus from the node behind `nodeId` (fires blur/change handlers). */
  blur(nodeId: string): Promise<void>;
  /** Discrete mouse primitive at PAGE coordinates (not a nodeId) — 'move' for
   * mousemove-driven UI (custom drag handles, hover-tracking widgets), 'down'/
   * 'up' to compose gestures the click()/dragAndDrop() helpers don't cover. */
  mouse(kind: 'move' | 'down' | 'up', x: number, y: number): Promise<void>;
  /** Open a new tab/target at `url` WITHOUT switching the active session to it;
   * returns an opaque id usable with switchTab()/closeTab(). */
  openTab(url: string): Promise<string>;
  /** Switch the active session to a previously-opened tab (by the id openTab()
   * returned, or a transport-defined index). The tab that WAS active becomes
   * switchable back to. Extension transports that cannot manage tabs without
   * additional bridge/chrome.tabs plumbing throw a clear "not supported"
   * error instead of a silent no-op. */
  switchTab(idOrIndex: string | number): Promise<void>;
  /** Close a tab previously opened with openTab(). Throws if `id` is the
   * currently active tab — switchTab() away first. */
  closeTab(id: string): Promise<void>;
  screenshot(): Promise<Buffer>;
  setLogpoint(spec: LogpointSpec): Promise<void>;
  /** Everything captured since the previous drain — per-step evidence correlation. */
  drainConsole(): ConsoleEntry[];
  drainNetwork(): NetworkEntry[];
  /** Raw CDP-shaped client for extras outside this contract (clip recorder).
   * Optional: a future transport may not expose one. */
  cdpClient?(): unknown;
  /** Stamp a stable `data-qa-id` attribute on the node behind `nodeId` (from the
   * current snapshot's nodeMap) and return the id value, or null when it can't be
   * stamped (node gone, no resolvable object). Lets the recorder give name-less
   * interaction targets a fallback locator (#9). Optional: a transport may not
   * implement it (the loop guards the call). */
  stampQaId?(nodeId: string): Promise<string | null>;
  /** A24 Tier-0 oracle: evaluate the invariant probe in the page and return its
   * raw JSON-serialisable result (parsed by assertions/invariants.ts, which
   * treats any shape defensively). Deliberately NOT a general `evaluate(js)`:
   * the port runs one compile-time constant (INVARIANT_PROBE_JS), so no
   * model-supplied or recorded code can ever reach an eval — the same posture
   * the script runner takes (see driver/script-runner/schema.ts). Optional: a
   * transport that cannot evaluate returns undefined and the loop records only
   * the drain-derived invariants. */
  probeInvariants?(): Promise<unknown>;
  /** Locate a node in the CURRENT page by a previously-stamped `data-qa-id` and
   * return a nodeId usable with click()/type(), or null when not present (e.g.
   * the attribute was lost across a reload). Implementations register the match
   * into their own nodeMap so the returned id resolves. Optional. */
  findByQaId?(qaId: string): Promise<string | null>;
  /** A8 (P1): locate a node in the CURRENT page by a `data-testid` (or
   * `data-test-id`/`data-test`/`data-qa`) attribute and return a nodeId usable
   * with click()/type(), or null when no element carries it. This is the LIVE
   * fallback for the uncommon case — the common path resolves testid straight
   * out of the already-fetched AxSnapshot (`AxNode.testId`, populated once per
   * snapshot with no extra round-trip); this method exists for the moment the
   * snapshot is stale (element rendered after it was taken) or was pruned for
   * an unrelated reason. Implementations register the match into their own
   * nodeMap so the returned id resolves. Optional. */
  findByTestId?(testId: string): Promise<string | null>;
  /** A4 (P0): resolves once the network has gone quiet (no in-flight requests
   * for `networkQuietMs`) or `timeoutMs` elapses, whichever first — the
   * condition-based replacement for the ~20 fixed sleeps this finding names.
   * MUST be non-destructive: implementations must NOT consume drainConsole()/
   * drainNetwork()'s buffers (the step record still needs everything in them)
   * — see createNetworkIdleTracker's doc comment for how CdpBrowser/
   * ExtensionBrowser satisfy that with an independent listener, not a second
   * drain. NEVER rejects on timeout — see WaitForIdleOptions. Optional: a
   * transport with no Network-domain visibility can't implement this
   * meaningfully and should leave it unset rather than fake it; callers must
   * guard the call (`browser.waitForIdle?.(...)`). */
  waitForIdle?(opts?: WaitForIdleOptions): Promise<void>;
  /** A4 (P0): Playwright-style actionability wait for the node behind
   * `nodeId` — resolves once it is attached, visible (non-zero box, not
   * `visibility:hidden`/`display:none`), enabled (not `disabled`/
   * `aria-disabled="true"`), AND stable (bounding box unchanged across two
   * consecutive animation frames). Unlike waitForIdle, this DOES fail loudly
   * (throws) once `timeoutMs` elapses without ever being actionable — an
   * element the AX tree resolved by role+name but that is hidden/disabled/
   * still animating is a real, worth-surfacing distinction from "not found at
   * all", not something to silently paper over. Optional: a transport with no
   * node-scoped JS evaluation can't implement this and should leave it unset;
   * callers must guard the call. */
  waitForActionable?(nodeId: string, opts?: WaitForActionableOptions): Promise<void>;
  close(): Promise<void>;
}
