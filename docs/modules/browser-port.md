# Module: Browser Port

> Scope: BrowserPort interface and all implementations — CdpBrowser, ExtensionBrowser, bridge, and Nano ports.
> Rendering context: Server-side (Node.js daemon)
> Project tier: 3
> Last updated: 2026-06-11

## Overview

BrowserPort (src/ports/browser-port.ts) is the abstract interface that isolates the driver loop, recorder, and engine from how Chrome is actually controlled. CdpBrowser (CDP mode) and ExtensionBrowser (vibe mode) both implement it. This contract is what lets the same driver loop work in both transports with zero engine changes.

AGENT OWNER: src/ports/

## BrowserPort Interface (src/ports/browser-port.ts)

Key methods on BrowserPort:

- launch() — initialize the session (attach to CDP port, or wait for extension SW connection).
- navigate(url) — navigate the active tab.
- url() — return the current page URL.
- click(nodeId) — click the node identified by its snapshot stable ID.
- type(nodeId, text) — type text into the node (resolves {{secret:…}} before calling — see driver loop).
- screenshot() — capture a PNG buffer via Page.captureScreenshot.
- axTree() — return an AxSnapshot: { text: string, root: AxNode }. text is the compact pruned tree; root is the structured tree for node lookup.
- drainConsole() — return and clear buffered ConsoleEntry[] since last drain.
- drainNetwork() — return and clear buffered NetworkEntry[] since last drain.
- stampQaId?(nodeId) — optional: stamp a data-qa-id attribute on a name-less node as a fallback replay locator.
- cdpClient?() — optional: expose the raw CDP session for screencast recording.
- close() — close the QA tab; Chrome and runner tab stay warm.

AGENT NOTE: Node IDs (nodeId strings like n7) are per-snapshot stable but meaningless across runs. The recorder stores role+name instead, not nodeId. The driver loop uses nodeId for execution within a single snapshot; the recorder reads StepRecord.target for persistence.

## CdpBrowser (src/ports/cdp-browser.ts)

The real browser implementation. Uses chrome-remote-interface to connect to Chrome on cfg.cdpPort. Spawns Chrome (with the profile dir) if nothing is listening on that port. Navigation, click, type, and screenshot are direct CDP domain calls. The accessibility tree is obtained via Accessibility.getFullAXTree and pruned by src/capture/axtree.ts. Console and network events are buffered by src/capture/console-network.ts listeners registered at launch.

AGENT NOTE: CdpBrowser runs a HEADED Chrome (headless: false). This is required for Gemini Nano: the Prompt API refuses to load in headless mode. Never change this to headless without verifying Nano still works.

## ExtensionBrowser (src/ports/extension-browser.ts)

The vibe-mode stub. Delegates each BrowserPort method to the extension's service worker (sw.js) via JSON-RPC messages over the BridgeServer WebSocket. The CDP operations are proxied by sw.js through chrome.debugger. Some CDP domains that CdpBrowser uses directly (e.g., Page.startScreencast) are not exposed through chrome.debugger — these are the known extension-mode limitations documented in TODO.md.

AGENT AVOID: Do not implement new CdpBrowser features that depend on CDP domains not available in chrome.debugger without also providing an ExtensionBrowser fallback or no-op. The two implementations must stay in functional parity for all capabilities the driver loop requires.

## Bridge (src/bridge/bridge-server.ts and src/bridge/cdp-shim.ts)

BridgeServer is a WebSocket server that relays JSON-RPC messages between the daemon and the extension service worker. The protocol has three message shapes:

- Daemon → extension: { id, method, params } — a CDP-like request.
- Extension → daemon (response): { rid, result } or { rid, error } — matches by id.
- Extension → daemon (event): { event, data } — fan-out (e.g., console messages, vibe.step).

cdp-shim.ts in the extension service worker (sw.js imports it) translates the bridge messages to chrome.debugger.sendCommand calls and forwards the responses back over the WebSocket.

The daemon allocates each connected Chrome a unique clientId. In multi-Chrome scenarios, a run binds to the specific clientId that issued the vibe.run request (opts.clientId), so a second connected Chrome cannot have its tabs driven by this run.

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

## Related Docs

- docs/architecture/data-flow.md — how the driver loop calls BrowserPort
- docs/modules/engine.md — how CdpBrowser vs ExtensionBrowser is selected
- docs/modules/vibe-mode.md — vibe mode uses ExtensionBrowser + BridgeServer
- docs/infra/environment.md — QA_CDP_PORT, QA_RUNNER_PORT, QA_BRIDGE_PORT
