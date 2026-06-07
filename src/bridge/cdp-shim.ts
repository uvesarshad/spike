/* CDP shim — makes a BridgeServer + a bound tabId look like a chrome-remote-
 * interface CDP.Client, so the existing capture modules (axtree.ts,
 * console-network.ts, logpoints.ts) run UNCHANGED over the extension transport.
 *
 * chrome-remote-interface exposes two call shapes on a client:
 *   - method:  client.<Domain>.<method>(params) → Promise<result>
 *   - event:   client.<Domain>.<eventName>(handler) → registers handler;
 *              the daemon receives forwarded CDP events as bridge events
 *              { event: 'cdp', params: { tabId, method: 'Domain.eventName', params } }.
 *
 * We disambiguate the two the same way the capture code uses them: an event
 * subscription is invoked with exactly one *function* argument; everything else
 * is a command whose single argument is a params object (or undefined). This
 * matches every usage in src/capture/* and src/ports/cdp-browser.ts.
 */

import type CDP from 'chrome-remote-interface';
import type { BridgeServer, BridgeEvent } from './bridge-server.js';

type CdpCommand = (params?: Record<string, unknown>) => Promise<unknown>;
type CdpEventSub = (handler: (params: Record<string, unknown>) => void) => void;
type CdpMember = CdpCommand & CdpEventSub;

export interface CdpShim {
  client: CDP.Client;
  /** Detach the bridge event listener (call when the tab/browser closes). */
  dispose(): void;
}

/**
 * Build a Proxy that satisfies the subset of CDP.Client the capture/executor
 * code touches, routing everything to `bridge` for the given `tabId`.
 */
export function createCdpShim(bridge: BridgeServer, tabId: number, callTimeoutMs = 30_000): CdpShim {
  // "Domain.eventName" → set of handlers registered for it
  const eventHandlers = new Map<string, Set<(params: Record<string, unknown>) => void>>();

  const onBridgeEvent = (evt: BridgeEvent): void => {
    if (evt.event !== 'cdp') return;
    const p = evt.params as { tabId?: number; method?: string; params?: Record<string, unknown> };
    if (p.tabId !== tabId || typeof p.method !== 'string') return;
    const handlers = eventHandlers.get(p.method);
    if (!handlers) return;
    for (const h of handlers) {
      try { h(p.params ?? {}); } catch { /* a bad handler must not drop the event */ }
    }
  };
  bridge.onEvent(onBridgeEvent);

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
      // command shape: params object (or none) → bridge `cdp` call
      return bridge.call(
        'cdp',
        { tabId, method: fullName, params: (arg as Record<string, unknown>) ?? {} },
        callTimeoutMs,
      );
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
      if (prop === 'close') return async () => { /* transport owned by the bridge */ };
      if (prop === 'then') return undefined; // not a thenable
      return domainProxy(prop);
    },
  }) as unknown as CDP.Client;

  return {
    client,
    dispose() {
      bridge.offEvent(onBridgeEvent);
      eventHandlers.clear();
    },
  };
}
