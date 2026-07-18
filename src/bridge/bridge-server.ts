/* BridgeServer — the daemon side of the daemon↔extension WebSocket bridge.
 *
 * The MV3 extension's service worker connects in (ws://localhost:<port>/), and
 * the daemon drives Chrome through it via chrome.debugger. This is the transport
 * that lets ExtensionBrowser satisfy BrowserPort without a daemon-launched CDP
 * port — the "vibe mode" plumbing.
 *
 * Wire protocol (JSON, one object per WS message):
 *   daemon→ext request : { id: number, method: string, params?: object }
 *   ext→daemon response: { id: number, result?: unknown, error?: string }
 *   ext→daemon event   : { event: string, params: object }   (CDP events + lifecycle)
 *   ext→daemon request : { rid: number, method: string, params?: object }  (vibe-mode UI → daemon)
 *   daemon→ext response: { rid: number, result?: unknown, error?: string }
 *
 * `rid` keys the REVERSE direction (side panel asking the daemon to run QA);
 * `id` stays daemon→ext. The two id-spaces never collide because they travel
 * under different keys.
 *
 * Multi-client model: every accepted socket (post hello-gate) gets a monotonic
 * `clientId`. Two Chromes running the extension can connect at once (no more
 * "newest socket wins" — that caused the "No tab with id" bug where a tab was
 * created on Chrome A then driven on Chrome B). `defaultClient` is the
 * most-recently-adopted client, so every legacy single-client API (call/
 * sendEvent/waitForExtension with no clientId) behaves EXACTLY as before. New
 * targeted overloads take `{ clientId }` to address a specific Chrome, and
 * onRequest/onEvent handlers receive a `ctx: { clientId }` second arg so a
 * handler can route its work and its reply events back to the asking Chrome.
 *
 * Response routing: each pending daemon→ext request remembers which client it
 * was sent to; a `{ id }` response is only accepted from THAT client. The
 * daemon's `id` counter is global (ids are unique across clients), but the
 * origin check hardens against a stray/duplicate frame.
 *
 * Protocol-version handshake (A4): a real extension hello (`{event:'hello',
 * params:{caps:[...], protocolVersion?}}`) gets an immediate `bridge.hello`
 * event back — `{event:'bridge.hello', params:{protocolVersion:PROTOCOL_VERSION}}`
 * — addressed to that client. The extension compares this against the minimum
 * it requires and, if the daemon is too old (or never acks), tells the panel
 * to show "update the desktop app" instead of a plain green "connected" dot.
 * Bump PROTOCOL_VERSION whenever the wire protocol changes in a way both
 * sides must agree on to work correctly.
 *
 * Connection hardening (A9): the WS server rejects any handshake whose
 * `Origin` header is an http(s) page (the main "arbitrary local web page
 * drives the daemon" threat) before it ever reaches the hello/adopt logic
 * below. The extension's service worker/offscreen document connects with no
 * Origin header at all or `chrome-extension://<id>` — both pass through
 * unchanged, as do our own `ws`-based test/CLI clients (which also send no
 * Origin header).
 *
 * Pairing token (A2/A6): the Origin check alone only stops a browser page's
 * WebSocket (Origin is browser-enforced) — a bare local process can omit or
 * forge the header entirely, so it can't be the real gate. Every client must
 * now present a `token` in its first frame's `hello.params`, matched against
 * a pairing token persisted in the Vault (src/vault/vault.ts) under
 * `PAIRING_TOKEN_VAULT_KEY`. Trust-on-first-use: the first token ANY client
 * ever presents is adopted as THE pairing token (the extension mints one on
 * first install — see extension/sw.js — and persists it in
 * chrome.storage.local so reconnects keep presenting the same one); every
 * later connection must match it exactly or the socket is closed before
 * adoption. This closes the "any local process can connect" hole (A2) and
 * makes the Origin check's forgeability (A6) moot — Origin remains as a
 * cheap additional layer, not the primary gate.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { Vault } from '../vault/vault.js';

export const DEFAULT_BRIDGE_PORT = 9410;
/** Loopback-only by default (A1) — the WS server used to omit `host`
 * entirely, which made `ws`/Node default to binding ALL interfaces. */
export const DEFAULT_BRIDGE_HOST = '127.0.0.1';
/** Vault key the daemon's half of the pairing token (A2) is stored under. */
export const PAIRING_TOKEN_VAULT_KEY = 'bridge-pairing-token';

/** Daemon↔extension wire-protocol version. Bump when a change requires both
 * sides to be updated together; the extension refuses to call itself
 * "connected & healthy" against a daemon reporting a version it doesn't
 * support (see `sw.js`'s MIN_DAEMON_PROTOCOL_VERSION). */
export const PROTOCOL_VERSION = 1;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Which client this request was sent to — a response is only honored from it. */
  clientId: number;
}

export interface BridgeEvent {
  event: string;
  params: Record<string, unknown>;
}

/** Context passed to event/request handlers identifying the originating client. */
export interface ClientCtx {
  clientId: number;
}

/** Optional target for a targeted call/sendEvent. Absent → the default client. */
export interface ClientTarget {
  clientId?: number;
}

type EventHandler = (evt: BridgeEvent, ctx: ClientCtx) => void;
type RequestHandler = (params: Record<string, unknown>, ctx: ClientCtx) => Promise<unknown>;

export class BridgeServer {
  private readonly wss: WebSocketServer;
  /** clientId → live socket. */
  private readonly clients = new Map<number, WebSocket>();
  /** Most-recently-adopted clientId — the implicit target of legacy API calls. */
  private defaultClientId: number | null = null;
  private nextClientId = 1;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly eventHandlers = new Set<EventHandler>();
  /** ext→daemon request handlers, keyed by method (vibe-mode reverse RPC). */
  private readonly requestHandlers = new Map<string, RequestHandler>();
  /** Resolvers waiting on the first (or next) extension connection. */
  private connectWaiters: Array<() => void> = [];
  /** The pairing token (A2) every client's first frame must present. `null`
   * until the first-ever client pairs (trust-on-first-use) — persisted in the
   * Vault so it survives daemon restarts. */
  private pairingToken: string | null;

  constructor(
    private readonly port: number = DEFAULT_BRIDGE_PORT,
    private readonly host: string = DEFAULT_BRIDGE_HOST,
  ) {
    this.wss = new WebSocketServer({ port: this.port, host: this.host });
    try {
      this.pairingToken = new Vault().get(PAIRING_TOKEN_VAULT_KEY) ?? null;
    } catch {
      this.pairingToken = null; // vault unreadable — treat as unpaired
    }
    this.wss.on('connection', (ws, req) => {
      // A9 hardening: reject a handshake carrying an http(s) Origin — that's
      // a real web page's WebSocket, the main threat on a shared localhost
      // port. No Origin header (our `ws`-based test/CLI clients) or a
      // `chrome-extension://` Origin (the real extension) both pass through.
      const origin = req.headers.origin;
      if (typeof origin === 'string' && /^https?:\/\//i.test(origin)) {
        try { ws.close(1008, 'origin not allowed'); } catch { /* already gone */ }
        return;
      }

      // Defer adoption until the first frame: a STALE extension copy (old sw.js
      // in another Chrome profile — its reconnect loop scans our port range)
      // announces itself with a capability-less hello and gets rejected instead
      // of joining as a client. Anything else (current SW hello-with-caps, test
      // clients that talk immediately) adopts as before.
      const probe = (data: { toString(): string }) => {
        let first: Record<string, unknown> | null = null;
        try {
          first = JSON.parse(data.toString()) as Record<string, unknown>;
        } catch {
          /* malformed — fall through; the token check below rejects it (no token) */
        }
        let isHello = false;
        let token: string | undefined;
        if (first && first.event === 'hello') {
          const params = first.params as { caps?: unknown; token?: unknown } | undefined;
          const caps = params?.caps;
          if (!Array.isArray(caps) || caps.length === 0) {
            try { ws.close(); } catch { /* gone */ }
            return; // stale-code SW — do not adopt
          }
          isHello = true;
          token = typeof params?.token === 'string' ? params.token : undefined;
        }

        // A2: every client must present the current pairing token on its
        // first frame to be adopted at all — closes the "any local process
        // can connect with no auth" hole. Trust-on-first-use: the first token
        // ever presented becomes THE pairing token, persisted so every later
        // connection (including this one, on reconnect) must match it.
        if (this.pairingToken === null) {
          if (!token) {
            try { ws.close(1008, 'pairing token required'); } catch { /* gone */ }
            return;
          }
          this.pairingToken = token;
          try { new Vault().set(PAIRING_TOKEN_VAULT_KEY, token); } catch { /* best-effort persist */ }
        } else if (token !== this.pairingToken) {
          try { ws.close(1008, 'pairing token mismatch'); } catch { /* gone */ }
          return;
        }

        ws.off('message', probe);
        const clientId = this.adopt(ws);
        this.onMessage(clientId, data.toString()); // don't lose the first frame
        // A4 handshake: a real extension hello gets an immediate ack carrying
        // OUR protocol version, so it can flag an outdated daemon instead of
        // reporting "connected & healthy" for a version that can't drive it.
        if (isHello) {
          this.sendEvent('bridge.hello', { protocolVersion: PROTOCOL_VERSION }, { clientId });
        }
      };
      ws.on('message', probe);
    });
  }

  /** Adopt a freshly connected extension socket as a new client; returns its id.
   * The new client becomes the default (most-recent) target — preserving the
   * legacy "talk to the latest socket" behavior for un-targeted calls. */
  private adopt(ws: WebSocket): number {
    const clientId = this.nextClientId++;
    this.clients.set(clientId, ws);
    this.defaultClientId = clientId;

    ws.on('message', (data) => this.onMessage(clientId, data.toString()));
    ws.on('close', () => this.dropClient(clientId, ws));
    ws.on('error', () => this.dropClient(clientId, ws));

    const waiters = this.connectWaiters;
    this.connectWaiters = [];
    for (const w of waiters) w();
    return clientId;
  }

  /** Remove a disconnected client: forget its socket, reject its in-flight
   * requests, and pick a new default if it was the default. */
  private dropClient(clientId: number, ws: WebSocket): void {
    if (this.clients.get(clientId) !== ws) return; // already replaced/removed
    this.clients.delete(clientId);

    // reject any daemon→ext requests still waiting on this client
    for (const [id, p] of this.pending) {
      if (p.clientId === clientId) {
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.reject(new Error('client disconnected'));
      }
    }

    if (this.defaultClientId === clientId) {
      // newest surviving client becomes the default (highest id)
      let next: number | null = null;
      for (const id of this.clients.keys()) {
        if (next === null || id > next) next = id;
      }
      this.defaultClientId = next;
    }
  }

  private onMessage(clientId: number, raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // ignore malformed frames
    }
    if (!msg || typeof msg !== 'object') return;
    const obj = msg as Record<string, unknown>;

    // response to a daemon→ext request
    if (typeof obj.id === 'number') {
      const pending = this.pending.get(obj.id);
      if (!pending) return;
      // origin check: a response is only honored from the client we sent to
      if (pending.clientId !== clientId) return;
      this.pending.delete(obj.id);
      clearTimeout(pending.timer);
      if (typeof obj.error === 'string') {
        pending.reject(new Error(obj.error));
      } else {
        pending.resolve(obj.result);
      }
      return;
    }

    // ext→daemon request (vibe-mode reverse RPC) → daemon→ext response
    if (typeof obj.rid === 'number' && typeof obj.method === 'string') {
      const rid = obj.rid;
      const method = obj.method;
      const params = (obj.params as Record<string, unknown>) ?? {};
      const handler = this.requestHandlers.get(method);
      if (!handler) {
        this.respond(clientId, rid, undefined, `unknown method ${method}`);
        return;
      }
      // Run async; a handler throw becomes an error response, never a crash.
      void Promise.resolve()
        .then(() => handler(params, { clientId }))
        .then(
          (result) => this.respond(clientId, rid, result, undefined),
          (err) => this.respond(clientId, rid, undefined, err instanceof Error ? err.message : String(err)),
        );
      return;
    }

    // ext→daemon event (CDP events + lifecycle)
    if (typeof obj.event === 'string') {
      const evt: BridgeEvent = {
        event: obj.event,
        params: (obj.params as Record<string, unknown>) ?? {},
      };
      const ctx: ClientCtx = { clientId };
      for (const handler of this.eventHandlers) {
        try { handler(evt, ctx); } catch { /* a bad handler must not kill the bridge */ }
      }
    }
  }

  /** Resolve once an extension is connected (or already is) — any client. */
  waitForExtension(timeoutMs = 30_000): Promise<void> {
    if (this.defaultClientId !== null) {
      const ws = this.clients.get(this.defaultClientId);
      if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.connectWaiters = this.connectWaiters.filter((w) => w !== onConnect);
        reject(new Error(`no extension connected within ${timeoutMs}ms`));
      }, timeoutMs);
      const onConnect = () => {
        clearTimeout(timer);
        resolve();
      };
      this.connectWaiters.push(onConnect);
    });
  }

  /** Currently-connected client ids (in adoption order). */
  clientIds(): number[] {
    return [...this.clients.keys()];
  }

  /** True when `clientId` is currently connected — every adopted client
   * already passed the pairing-token gate in the connection handler (A2), so
   * this doubles as "authenticated". Reverse-RPC handlers (A3, vibe/service.ts)
   * should check this explicitly rather than assume any onRequest call is
   * inherently safe. */
  isAuthenticated(clientId: number): boolean {
    return this.clients.has(clientId);
  }

  /** Resolve a target clientId: explicit if given, else the default (most-recent). */
  private resolveClient(opts?: ClientTarget): { clientId: number; ws: WebSocket } | { error: string } {
    const clientId = opts?.clientId ?? this.defaultClientId;
    if (clientId === null || clientId === undefined) {
      return { error: 'bridge: no extension connected' };
    }
    const ws = this.clients.get(clientId);
    if (!ws) return { error: `bridge: no such client ${clientId}` };
    if (ws.readyState !== WebSocket.OPEN) return { error: `bridge: client ${clientId} not open` };
    return { clientId, ws };
  }

  /** Send a daemon→ext request and await its response.
   * `opts.clientId` targets a specific Chrome; absent → the default client. */
  call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 30_000,
    opts?: ClientTarget,
  ): Promise<T> {
    const target = this.resolveClient(opts);
    if ('error' in target) return Promise.reject(new Error(target.error));
    const { clientId, ws } = target;
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`bridge call ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        clientId,
      });
      const frame = JSON.stringify({ id, method, ...(params !== undefined && { params }) });
      ws.send(frame, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  /** Push a daemon→ext event (fire-and-forget; no response expected).
   * Used for vibe-mode UI fan-out: progress lines, ghost-cursor moves, done.
   * `opts.clientId` targets a specific Chrome; absent → the default client. */
  sendEvent(event: string, params: Record<string, unknown> = {}, opts?: ClientTarget): void {
    const target = this.resolveClient(opts);
    if ('error' in target) return; // no panel attached — fine
    try {
      target.ws.send(JSON.stringify({ event, params }));
    } catch {
      /* fire-and-forget */
    }
  }

  /** Send a daemon→ext response to an ext→daemon request (keyed by `rid`),
   * back to the client that asked. */
  private respond(clientId: number, rid: number, result: unknown, error: string | undefined): void {
    const ws = this.clients.get(clientId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return; // socket gone; nothing to answer
    const frame = error !== undefined ? { rid, error } : { rid, result };
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      /* fire-and-forget */
    }
  }

  /** Register an ext→daemon request handler for a method (vibe-mode reverse RPC).
   * The handler receives `(params, ctx: { clientId })`; its resolved value is sent
   * back as `{rid, result}`, a throw becomes `{rid, error}`. Existing handlers that
   * ignore the second arg keep working. Re-registering a method replaces the prior. */
  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  /** Subscribe to ext→daemon events (CDP events + lifecycle). The handler receives
   * `(evt, ctx: { clientId })`; handlers that ignore the second arg keep working. */
  onEvent(handler: EventHandler): void {
    this.eventHandlers.add(handler);
  }

  /** Stop listening to events from a previously registered handler. */
  offEvent(handler: EventHandler): void {
    this.eventHandlers.delete(handler);
  }

  async close(): Promise<void> {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('bridge closing'));
    }
    this.pending.clear();
    this.eventHandlers.clear();
    this.requestHandlers.clear();
    for (const ws of this.clients.values()) {
      try { ws.close(); } catch { /* already gone */ }
    }
    this.clients.clear();
    this.defaultClientId = null;
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
