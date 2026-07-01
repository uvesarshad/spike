/* CDP shim — makes a transport (the daemon↔extension bridge, OR chrome.debugger
 * directly in lite mode) look like a chrome-remote-interface CDP.Client, so the
 * existing capture modules (axtree.ts, console-network.ts, logpoints.ts) and the
 * executor run UNCHANGED over either transport.
 *
 * chrome-remote-interface exposes two call shapes on a client:
 *   - method:  client.<Domain>.<method>(params) → Promise<result>
 *   - event:   client.<Domain>.<eventName>(handler) → registers handler.
 *
 * We disambiguate the two the same way the capture code uses them: an event
 * subscription is invoked with exactly one *function* argument; everything else
 * is a command whose single argument is a params object (or undefined). This
 * matches every usage in src/capture/* and src/ports/cdp-browser.ts.
 *
 * buildCdpClient() is the transport-agnostic core. createCdpShim() wires it to a
 * BridgeServer (daemon mode); lite mode wires it to chrome.debugger via a
 * CdpTransport built in the service worker (no bridge). The BridgeServer/CDP
 * imports below are TYPE-ONLY so the lite browser bundle pulls in no Node deps.
 */

import type CDP from 'chrome-remote-interface';
import type { BridgeServer, BridgeEvent, ClientCtx } from './bridge-server.js';

type CdpCommand = (params?: Record<string, unknown>) => Promise<unknown>;
type CdpEventSub = (handler: (params: Record<string, unknown>) => void) => void;
type CdpMember = CdpCommand & CdpEventSub;

export interface CdpShim {
  client: CDP.Client;
  /** Detach the event listener (call when the tab/browser closes). */
  dispose(): void;
}

export interface CdpShimOptions {
  callTimeoutMs?: number;
  /** When set, bind to a specific bridge client: all `cdp` commands target it
   * AND inbound CDP events are filtered to it (multi-Chrome isolation). Absent →
   * default-client behavior (events accepted from any client). */
  clientId?: number;
}

/** The minimal transport buildCdpClient needs. `send` issues one CDP command;
 * `subscribe` registers a handler for ALL forwarded CDP events (already filtered
 * to the relevant tab by the transport) and returns an unsubscribe fn. */
export interface CdpTransport {
  send(method: string, params: Record<string, unknown>): Promise<unknown>;
  subscribe(handler: (method: string, params: Record<string, unknown>) => void): () => void;
}

/**
 * Build a Proxy that satisfies the subset of CDP.Client the capture/executor
 * code touches, routing every command/event through `transport`. Transport-
 * agnostic: works over the bridge OR chrome.debugger.
 */
export function buildCdpClient(transport: CdpTransport): CdpShim {
  // "Domain.eventName" → set of handlers registered for it
  const eventHandlers = new Map<string, Set<(params: Record<string, unknown>) => void>>();

  const unsubscribe = transport.subscribe((method, params) => {
    const handlers = eventHandlers.get(method);
    if (!handlers) return;
    for (const h of handlers) {
      try { h(params ?? {}); } catch { /* a bad handler must not drop the event */ }
    }
  });

  const makeMember = (domain: string, name: string): CdpMember => {
    const fullName = `${domain}.${name}`;
    const member = ((arg?: unknown): unknown => {
      // event-subscription shape: single function argument
      if (typeof arg === 'function') {
        let set = eventHandlers.get(fullName);
        if (!set) {
          set = new Set();
          eventHandlers.set(fullName, set);
        }
        set.add(arg as (params: Record<string, unknown>) => void);
        // crI returns an unsubscribe function; mirror that for parity
        return () => set!.delete(arg as (params: Record<string, unknown>) => void);
      }
      // command shape: params object (or none) → transport send.
      return transport.send(fullName, (arg as Record<string, unknown>) ?? {});
    }) as CdpMember;
    return member;
  };

  // Per-domain proxy: any property access becomes a CDP member for that domain.
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
          m = makeMember(domain, name);
          members.set(name, m);
        }
        return m;
      },
    });
    domainProxies.set(domain, proxy);
    return proxy;
  };

  // top-level client: client.<Domain> → domain proxy; client.close() → no-op
  const client = new Proxy({} as Record<string, unknown>, {
    get(_t, prop: string | symbol) {
      if (typeof prop !== 'string') return undefined;
      if (prop === 'close') return async () => { /* transport owned elsewhere */ };
      if (prop === 'then') return undefined; // not a thenable
      return domainProxy(prop);
    },
  }) as unknown as CDP.Client;

  return {
    client,
    dispose() {
      unsubscribe();
      eventHandlers.clear();
    },
  };
}

/**
 * Bridge-backed shim (daemon mode): builds a CdpTransport from a BridgeServer +
 * tabId and feeds it to buildCdpClient. Behavior is identical to the previous
 * inlined implementation. When `opts.clientId` is set every call/event is scoped
 * to that bridge client.
 */
export function createCdpShim(
  bridge: BridgeServer,
  tabId: number,
  opts: CdpShimOptions = {},
): CdpShim {
  const callTimeoutMs = opts.callTimeoutMs ?? 30_000;
  const clientId = opts.clientId;
  const transport: CdpTransport = {
    send: (method, params) =>
      bridge.call(
        'cdp',
        { tabId, method, params },
        callTimeoutMs,
        clientId !== undefined ? { clientId } : undefined,
      ),
    subscribe: (handler) => {
      const onBridgeEvent = (evt: BridgeEvent, ctx: ClientCtx): void => {
        if (evt.event !== 'cdp') return;
        // bound to a client → only accept its events (multi-Chrome isolation)
        if (clientId !== undefined && ctx.clientId !== clientId) return;
        const p = evt.params as { tabId?: number; method?: string; params?: Record<string, unknown> };
        if (p.tabId !== tabId || typeof p.method !== 'string') return;
        handler(p.method, p.params ?? {});
      };
      bridge.onEvent(onBridgeEvent);
      return () => bridge.offEvent(onBridgeEvent);
    },
  };
  return buildCdpClient(transport);
}
