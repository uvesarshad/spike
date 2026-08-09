/* BrowserPort — the seam between the engine and whatever drives Chrome.
 * CdpBrowser (plain CDP, --remote-debugging-port) is the MVP implementation;
 * ExtensionBrowser (MV3 chrome.debugger) implements the same contract in the
 * vibe-mode milestone. The engine must only ever import this interface. */

export interface AxNode {
  /** Per-snapshot stable id the planner references in actions (e.g. "n7"). */
  id: string;
  role: string;
  name?: string;
  value?: string;
  /** Notable states: disabled, focused, required, checked… */
  states?: string[];
  children?: AxNode[];
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

/** True when host is exactly in allowedHosts or a subdomain of one of them.
 * Mirrors driver/loop.ts's hostAllowed() so both layers of the Tier-4 guard
 * (A4) agree on what "allowed" means. */
export function isHostAllowed(host: string, allowedHosts: string[]): boolean {
  return allowedHosts.some((allowed) => {
    const a = allowed.toLowerCase();
    return host === a || host.endsWith('.' + a);
  });
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

export interface BrowserPort {
  launch(): Promise<void>;
  navigate(url: string): Promise<void>;
  url(): Promise<string>;
  /** Snapshot the accessibility tree; refreshes the nodeId map used by click/type. */
  axTree(): Promise<AxSnapshot>;
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
  close(): Promise<void>;
}
