/* V57 — A23: VibeService aborts the active run on a `detached` bridge event.
 *
 * docs/plan/26-08-27-audit-market-readiness.md A23: extension/sw.js already
 * emits {event:'detached', params:{tabId, reason}} when chrome.debugger
 * detaches mid-run (e.g. the user dismissed Chrome's "<ext> is debugging this
 * browser" banner), but nothing in src/ subscribed to it — the run just kept
 * going and later failed with an opaque CDP error instead of a clear one.
 * VibeService.start() now registers a bridge.onEvent handler that aborts
 * `activeRun` on a matching `detached` event with a human message.
 *
 * NO real BridgeServer/socket here (that belongs in the browser bucket, see
 * v7/v22) — a plain in-memory fake stands in for BridgeServer's public
 * surface (onRequest/onEvent/offEvent/sendEvent/call/isAuthenticated), which
 * is all VibeService.start() touches. This isolates exactly the event-
 * subscription + abort-matching logic, not the transport plumbing.
 */

import { VibeService } from '../src/vibe/service.js';
import type { BridgeServer } from '../src/bridge/bridge-server.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

type Handler = (evt: { event: string; params: Record<string, unknown> }, ctx: { clientId: number }) => void;

/** Minimal stand-in for BridgeServer's public surface — just enough for
 * VibeService.start() to register its onEvent handler and for the test to
 * fire synthetic `detached` frames at it. */
class FakeBridge {
  private eventHandlers = new Set<Handler>();
  sentEvents: Array<{ event: string; params: Record<string, unknown> }> = [];

  onRequest(): void {
    /* VibeService.start() registers several vibe.* request handlers; the
     * detach-abort logic under test doesn't touch them, so this is a no-op. */
  }
  onEvent(handler: Handler): void {
    this.eventHandlers.add(handler);
  }
  offEvent(handler: Handler): void {
    this.eventHandlers.delete(handler);
  }
  sendEvent(event: string, params: Record<string, unknown> = {}): void {
    this.sentEvents.push({ event, params });
  }
  isAuthenticated(): boolean {
    return true;
  }
  call(): Promise<unknown> {
    return Promise.resolve({ ok: true });
  }

  /** Fire a synthetic ext→daemon event frame at every registered handler,
   * exactly as BridgeServer.onMessage does for a real `{event, params}` frame. */
  emit(event: string, params: Record<string, unknown>, clientId = 1): void {
    for (const handler of this.eventHandlers) handler({ event, params }, { clientId });
  }
}

function makeService(): { service: VibeService; bridge: FakeBridge } {
  const bridge = new FakeBridge();
  const service = new VibeService(bridge as unknown as BridgeServer);
  service.start();
  return { service, bridge };
}

/** Reach into VibeService's private run-tracking fields — this is a unit test
 * of internal state, not the public bridge protocol, so bypassing TS privacy
 * (a runtime no-op) is the deliberate way to simulate "a run is in flight"
 * without actually spawning qaRun/Chrome. */
type ServiceInternals = {
  activeRun: AbortController | null;
  activeRunTabId: number | null;
  detachAbortMessage: string | null;
};
const internals = (s: VibeService) => s as unknown as ServiceInternals;

function detachedEventAborts(): void {
  const { service, bridge } = makeService();
  const controller = new AbortController();
  internals(service).activeRun = controller;
  internals(service).activeRunTabId = 42;

  bridge.emit('detached', { tabId: 42, reason: 'canceled_by_user' });

  check('matching-tab detached event aborts the active run', controller.signal.aborted);
  check(
    'a clear human message is stashed for execute() to report',
    internals(service).detachAbortMessage === "Chrome's debugging session was closed",
  );
}

function mismatchedTabIsIgnored(): void {
  const { service, bridge } = makeService();
  const controller = new AbortController();
  internals(service).activeRun = controller;
  internals(service).activeRunTabId = 42;

  bridge.emit('detached', { tabId: 99, reason: 'canceled_by_user' });

  check('a detach for a DIFFERENT tab does not abort the active run', !controller.signal.aborted);
  check('no detach message stashed for a mismatched tab', internals(service).detachAbortMessage === null);
}

function unknownRunTabAcceptsAnyDetach(): void {
  // create-a-tab path: activeRunTabId is null because the daemon itself chose
  // the tab. Single-run invariant (only one active run ever) means any
  // detach must be about it.
  const { service, bridge } = makeService();
  const controller = new AbortController();
  internals(service).activeRun = controller;
  internals(service).activeRunTabId = null;

  bridge.emit('detached', { tabId: 7, reason: 'target_closed' });

  check('a detach with no known run-tab (create-a-tab path) still aborts', controller.signal.aborted);
}

function noActiveRunIsANoOp(): void {
  const { service, bridge } = makeService();
  // activeRun is null (no run in flight) — nothing to assert on it besides
  // "this must not throw" and "nothing gets sent".
  let threw = false;
  try {
    bridge.emit('detached', { tabId: 1, reason: 'canceled_by_user' });
  } catch {
    threw = true;
  }
  check('a detach event with no active run does not throw', !threw);
  check('nothing is sent to the bridge for it', bridge.sentEvents.length === 0);
}

function otherEventsAreIgnored(): void {
  const { service, bridge } = makeService();
  const controller = new AbortController();
  internals(service).activeRun = controller;
  internals(service).activeRunTabId = 42;

  bridge.emit('cdp', { tabId: 42, method: 'Page.frameNavigated', params: {} });
  bridge.emit('bridge.hello', { protocolVersion: 1 });

  check('non-detached bridge events do not abort the active run', !controller.signal.aborted);
}

detachedEventAborts();
mismatchedTabIsIgnored();
unknownRunTabAcceptsAnyDetach();
noActiveRunIsANoOp();
otherEventsAreIgnored();

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v57 checks passed`);
process.exit(failed.length ? 1 : 0);
