# Module: Browser Port

> Scope: BrowserPort interface and all implementations — CdpBrowser, ExtensionBrowser, bridge, and Nano ports.
> Rendering context: Server-side (Node.js daemon)
> Project tier: 3
> Last updated: 2026-07-18

## Overview

BrowserPort (src/ports/browser-port.ts) is the abstract interface that isolates the driver loop, recorder, and engine from how Chrome is actually controlled. CdpBrowser (CDP mode) and ExtensionBrowser (vibe mode) both implement it. This contract is what lets the same driver loop work in both transports with zero engine changes.

AGENT OWNER: src/ports/

## BrowserPort Interface (src/ports/browser-port.ts)

Key methods on BrowserPort:

- launch() — initialize the session (attach to CDP port, or wait for extension SW connection).
- navigate(url) — navigate the active tab.
- url() — return the current page URL.
- click(nodeId) — click the node identified by its snapshot stable ID.
- hover(nodeId) — move the mouse to the node center after scrolling it into view.
- type(nodeId, text) — type text into the node (resolves {{secret:…}} before calling — see driver loop).
- pressKey(key) — send a keyboard key such as Enter or Escape to the active page.
- selectOption(nodeId, value) — set a native select/combobox value and dispatch input/change events.
- reload() — reload the active page and wait for it to settle.
- goBack() — navigate back in the active tab history.
- uploadFile(nodeId, paths) — set files on a native `<input type="file">` (CDP: `DOM.setFileInputFiles`). Paths are whatever the caller resolved (recorded scripts keep them relative — see recorder.md); never invents or embeds secrets.
- dragAndDrop(sourceId, targetId) — press on sourceId's center, glide to targetId's center over several intermediate `mouseMoved` events, release (CDP: `Input.dispatchMouseEvent` press→move×N→release). Drives MOUSE-EVENT-based drag UI (sortable lists, sliders, custom drop zones) — it does NOT fire native HTML5 `draggable`/`dragstart`/`drop` events, which need an OS-level drag gesture CDP mouse events can't fake.
- blur(nodeId) — remove focus from the node (fires blur/change handlers some forms rely on for validation).
- mouse(kind, x, y) — a single discrete mouse event ('move'/'down'/'up') at PAGE coordinates (not a nodeId) — composes gestures click()/hover()/dragAndDrop() don't cover.
- openTab(url) — open a new tab/target WITHOUT switching the active session to it; returns an opaque id usable with switchTab()/closeTab().
- switchTab(idOrIndex) — switch the active session to a previously-opened tab. Accepts either the literal id openTab() returned (what the live navigator references, learned from step history text) OR CdpBrowser's numeric replay convention: 0 = the tab launch() started with, N (>=1) = the Nth tab openTab() created, in creation order — this is what a recorded script replays with (see recorder.md), since a raw runtime CDP target id would not exist on a later replay run. Ends the current action batch (mirrors navigate) since the a11y tree captured at batch start no longer describes the active page.
- closeTab(id) — close a tab previously opened with openTab(). Throws if `id` is the currently active tab (switchTab() away first).
- screenshot() — capture a PNG buffer via Page.captureScreenshot.
- axTree() — return an AxSnapshot: { text: string, root: AxNode }. text is the compact pruned tree; root is the structured tree for node lookup.
- drainConsole() — return and clear buffered ConsoleEntry[] since last drain.
- drainNetwork() — return and clear buffered NetworkEntry[] since last drain.
- stampQaId?(nodeId) — optional: stamp a data-qa-id attribute on a name-less node as a fallback replay locator.
- cdpClient?() — optional: expose the raw CDP session for screencast recording.
- close() — close the QA tab; Chrome and runner tab stay warm.

AGENT NOTE: Node IDs (nodeId strings like n7) are per-snapshot stable but meaningless across runs. The recorder stores role+name instead, not nodeId. The driver loop uses nodeId for execution within a single snapshot; the recorder reads StepRecord.target for persistence.

## Port-Layer Host Guard (src/ports/browser-port.ts)

A4 (P0) defense-in-depth: `driver/loop.ts` already re-checks `browser.url()` against the run's `allowedHosts` before every mutating action, but that check lives ONLY in the loop — a caller driving a `BrowserPort` directly, or a raw `cdp` passthrough on the extension side (`extension/sw.js`), bypasses it entirely. `browser-port.ts` exports the same check as free functions so both port implementations can re-run it themselves:

- `DEFAULT_ALLOWED_HOSTS` — `['localhost', '127.0.0.1']`, mirroring `driver/loop.ts`'s own default. NOT applied automatically when a port's `allowedHosts` option is omitted — `engine.ts` constructs `CdpBrowser`/`ExtensionBrowser` before it resolves the run's actual `allowedHosts` (loop.ts's Tier-4 default/`trustTargetHost` widening — see `engine.ts`'s `targetHostCandidates`), so defaulting the port to localhost-only here would silently break every non-localhost QA run.
- `hostOfUrl(url)` / `isHostAllowed(host, allowedHosts)` — pure helpers mirroring `driver/loop.ts`'s own `hostOf()`/`hostAllowed()` so both layers of the guard agree on what "allowed" means (exact match or subdomain of an allowed host).
- `assertMutationHostAllowed(host, allowedHosts, what)` — throws when `allowedHosts` is defined and `host` isn't in it; no-ops when `allowedHosts` is `undefined` (the caller didn't opt in to port-level enforcement — unchanged prior behavior).

`engine.ts` threads the run's resolved `allowedHosts` into both `CdpBrowser`'s and `ExtensionBrowser`'s constructor options; each port has a private `assertMutationAllowed(what)` that calls `assertMutationHostAllowed` against the LIVE page host (via `url()`) before every mutating primitive — `click`, `type`, `pressKey`, `selectOption`, `uploadFile`, `dragAndDrop`, `blur`, `mouse`. Read-only primitives (`navigate`, `reload`, `goBack`, `hover`, `screenshot`, `axTree`) stay unrestricted, mirroring `loop.ts`'s `MUTATING_ACTION_TYPES` semantics exactly. A blocked mutation throws (never silently no-ops), surfacing as a clear step failure.

AGENT AVOID: Do not add a new mutating BrowserPort method without also calling `assertMutationAllowed()` at its top in BOTH CdpBrowser and ExtensionBrowser — skipping it reopens the bypass this guard exists to close.

## CdpBrowser (src/ports/cdp-browser.ts)

The real browser implementation. Uses chrome-remote-interface to connect to Chrome on cfg.cdpPort. Spawns Chrome (with the profile dir) if nothing is listening on that port. Navigation, click, hover, keypress, select, reload, back, and screenshot are direct CDP domain calls. The accessibility tree is obtained via Accessibility.getFullAXTree and pruned by src/capture/axtree.ts. Console and network events are buffered by src/capture/console-network.ts listeners registered at launch. The constructor takes an optional `allowedHosts` alongside `LaunchOptions` — see "Port-Layer Host Guard" above.

AGENT NOTE: CdpBrowser runs a HEADED Chrome (headless: false). This is required for Gemini Nano: the Prompt API refuses to load in headless mode. Never change this to headless without verifying Nano still works.

AGENT NOTE (tabs): CdpBrowser tracks tabs it did not start with in `otherTabs` (a `Map<targetId, {client, capture}>`). Console/network `attachCapture()` runs EXACTLY ONCE per client — in `launch()` for the main tab, in `openTab()` for a new one — and travels with the client when `switchTab()` moves it in/out of `otherTabs`. Re-attaching on every `switchTab()` call was tried and reverted: it registers a SECOND set of `Runtime.consoleAPICalled`/`Network.*` listeners on the same client, which can surface stale/duplicate console entries later (observed via a `Debugger.setBreakpointByUrl` logpoint's conditional-log messages resurfacing after a `goBack()`-triggered back/forward-cache restore). `mainTabId` (set once in `launch()`) and `openOrder` (creation order) back `switchTab()`'s numeric convention: 0 = the original tab, N (>=1) = the Nth `openTab()` call — this is what replay uses (see recorder.md) since raw CDP target ids don't survive across runs.

## ExtensionBrowser (src/ports/extension-browser.ts)

The vibe-mode browser implementation. Delegates each BrowserPort method to the extension's service worker (sw.js) via JSON-RPC messages over the BridgeServer WebSocket. The CDP operations are proxied by sw.js through chrome.debugger. Driver-required actions stay in parity with CdpBrowser: navigate, click, hover, type, keypress, select, reload, goBack, upload/drag/blur/mouse, screenshots, a11y snapshots, console, and network capture. Some CDP domains that CdpBrowser uses directly (e.g., Page.startScreencast) are not exposed through chrome.debugger — these are the known extension-mode limitations documented in TODO.md. `ExtensionBrowserOptions` takes an optional `allowedHosts` — same "Port-Layer Host Guard" enforcement as CdpBrowser, re-checked against the live page host so a mutation reaching this port via the raw `cdp` bridge passthrough (extension/sw.js) can't bypass it either.

AGENT NOTE (tabs, extension transports): `openTab`/`switchTab`/`closeTab` are the ONE deliberate gap in ExtensionBrowser/LiteExtensionBrowser parity — both throw a clear "not supported in extension transport" error instead of a silent no-op. `chrome.tabs.create`/`update`/`remove` need a dedicated bridge RPC (`ext.openTab` etc.) the service worker does not expose yet; `chrome.debugger` has no tab-lifecycle surface to proxy. `uploadFile`/`dragAndDrop`/`blur`/`mouse` ARE fully implemented for both (same `DOM.setFileInputFiles`/`Input.dispatchMouseEvent` CDP calls proxied through the shim) — only the three tab primitives are transport-limited.

AGENT AVOID: Do not implement new CdpBrowser features that depend on CDP domains not available in chrome.debugger without also providing an ExtensionBrowser fallback or a documented "not supported" error (see the tabs note above for the current example). The two implementations must stay in functional parity for every OTHER capability the driver loop requires.

## Bridge (src/bridge/bridge-server.ts and src/bridge/cdp-shim.ts)

BridgeServer is a WebSocket server that relays JSON-RPC messages between the daemon and the extension service worker. The protocol has three message shapes:

- Daemon → extension: { id, method, params } — a CDP-like request.
- Extension → daemon (response): { rid, result } or { rid, error } — matches by id.
- Extension → daemon (event): { event, data } — fan-out (e.g., console messages, vibe.step).

cdp-shim.ts in the extension service worker (sw.js imports it) translates the bridge messages to chrome.debugger.sendCommand calls and forwards the responses back over the WebSocket.

The daemon allocates each connected Chrome a unique clientId. In multi-Chrome scenarios, a run binds to the specific clientId that issued the vibe.run request (opts.clientId), so a second connected Chrome cannot have its tabs driven by this run.

Connection hardening (added since the initial bridge): the WS server binds loopback-only (`DEFAULT_BRIDGE_HOST = '127.0.0.1'`, not all interfaces) and rejects any handshake whose `Origin` header is an http(s) page — the extension's service worker/offscreen document connects with no Origin header or `chrome-extension://<id>`, both of which pass through unchanged, as do `ws`-based test/CLI clients.

Pairing token (A2/A6): every client's first frame must present a `token` in its `hello.params`, matched against a pairing token persisted in the Vault (`src/vault/vault.ts`, `PAIRING_TOKEN_VAULT_KEY = 'bridge-pairing-token'`). Trust-on-first-use: the first token ANY client ever presents is adopted as THE pairing token (the extension mints one on first install and persists it in chrome.storage.local so reconnects keep presenting it); a later connection presenting no token, or the wrong one, is closed (code 1008) before adoption. `BridgeServer.isAuthenticated(clientId)` returns whether a clientId is currently connected (every adopted client already passed the pairing gate, so this doubles as "authenticated") — `VibeService`'s reverse-RPC handlers (`vibe.run`, `vibe.fix`, `vibe.config.set`, `vibe.key.set`, `vibe.key.clear`) call it explicitly rather than assuming any `onRequest` call is inherently safe.

Protocol-version handshake: a real extension hello (`{event:'hello', params:{caps:[...], token, protocolVersion?}}`) gets an immediate `{event:'bridge.hello', params:{protocolVersion:PROTOCOL_VERSION}}` back. The extension (sw.js's `MIN_DAEMON_PROTOCOL_VERSION`) compares this against the minimum it requires and, if the daemon is too old (or never acks), tells the panel to show "update Spike Core" instead of a plain green "connected" dot — see vibe-mode.md's "Connect Spike Core" section. Bump `PROTOCOL_VERSION` (currently 1) whenever the wire protocol changes in a way both sides must agree on to work correctly.

## Lite Extension Browser

LiteExtensionBrowser (src/extension/lite-extension-browser.ts) implements the same driver-facing BrowserPort actions inside the lightweight extension path. Keep this implementation in parity with BrowserPort when adding action methods; it is intentionally simpler than the daemon-side ExtensionBrowser but must support the actions emitted by the driver.

## Nano Ports

NanoRunnerPage (src/ports/nano-runner-page.ts) — For CDP mode. Starts a localhost HTTP server (cfg.runnerPort) serving a page from runner-assets.ts, then navigates a dedicated runner tab in the running Chrome to that page. The page invokes the Prompt API (window.ai) in response to postMessage calls from the port. start(), availability(), warmup(), verdict(prompt, png), close() are the key methods.

ExtensionNano (src/ports/extension-nano.ts) — For vibe mode with an injected bridge. Delegates Prompt API calls to the extension's nano-offscreen.html offscreen document via bridge messages instead of a runner page. Same interface as NanoRunnerPage.

NanoPort (src/ports/nano-port.ts) — Abstract interface for Nano access. Both NanoRunnerPage and ExtensionNano implement it.

runner-assets.ts (src/ports/runner-assets.ts) — The runner page HTML and in-page JavaScript as TypeScript string literals. Bundled at build time so dist/ is self-contained without serving static files from src/.

AGENT NOTE: During Nano model download, do NOT navigate the runner tab. Navigation cancels the create() promise (the ~2 GB component download survives, but the session is lost). Re-running re-attaches.

## Update Triggers

- When BrowserPort gains or loses a method (all implementations must be updated).
- When CdpBrowser uses a new CDP domain that ExtensionBrowser cannot support.
- When the bridge JSON-RPC protocol changes (message shapes, new event types).
- When the runner page HTML/JS changes (runner-assets.ts).
- When NanoPort gains a new lifecycle method.
- When a new mutating BrowserPort method is added (must call assertMutationAllowed() in both CdpBrowser and ExtensionBrowser — see "Port-Layer Host Guard").
- When the bridge's pairing/auth model changes (PAIRING_TOKEN_VAULT_KEY, isAuthenticated(), PROTOCOL_VERSION).

## Related Docs

- docs/architecture/data-flow.md — how the driver loop calls BrowserPort
- docs/modules/engine.md — how CdpBrowser vs ExtensionBrowser is selected
- docs/modules/vibe-mode.md — vibe mode uses ExtensionBrowser + BridgeServer
- docs/infra/environment.md — QA_CDP_PORT, QA_RUNNER_PORT, QA_BRIDGE_PORT
