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
 * Single-extension-client assumption: a second connection replaces the first
 * (the MV3 SW restarts and reconnects; we always talk to the latest socket).
 */

import { WebSocketServer, WebSocket } from 'ws';

export const DEFAULT_BRIDGE_PORT = 9410;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface BridgeEvent {
  event: string;
  params: Record<string, unknown>;
}

type EventHandler = (evt: BridgeEvent) => void;
type RequestHandler = (params: Record<string, unknown>) => Promise<unknown>;

export class BridgeServer {
  private readonly wss: WebSocketServer;
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly eventHandlers = new Set<EventHandler>();
  /** ext→daemon request handlers, keyed by method (vibe-mode reverse RPC). */
  private readonly requestHandlers = new Map<string, RequestHandler>();
  /** Resolvers waiting on the first (or next) extension connection. */
  private connectWaiters: Array<() => void> = [];

  constructor(private readonly port: number = DEFAULT_BRIDGE_PORT) {
    this.wss = new WebSocketServer({ port: this.port });
    this.wss.on('connection', (ws) => this.adopt(ws));
  }

  /** Adopt a freshly connected extension socket, replacing any prior one. */
  private adopt(ws: WebSocket): void {
    // a new SW connection supersedes the old socket (MV3 SW restarts)
    if (this.socket && this.socket !== ws) {
      try { this.socket.close(); } catch { /* already gone */ }
    }
    this.socket = ws;

    ws.on('message', (data) => this.onMessage(data.toString()));
    ws.on('close', () => {
      if (this.socket === ws) this.socket = null;
    });
    ws.on('error', () => {
      if (this.socket === ws) this.socket = null;
    });

    const waiters = this.connectWaiters;
    this.connectWaiters = [];
    for (const w of waiters) w();
  }

  private onMessage(raw: string): void {
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
        this.respond(rid, undefined, `unknown method ${method}`);
        return;
      }
      // Run async; a handler throw becomes an error response, never a crash.
      void Promise.resolve()
        .then(() => handler(params))
        .then(
          (result) => this.respond(rid, result, undefined),
          (err) => this.respond(rid, undefined, err instanceof Error ? err.message : String(err)),
        );
      return;
    }

    // ext→daemon event (CDP events + lifecycle)
    if (typeof obj.event === 'string') {
      const evt: BridgeEvent = {
        event: obj.event,
        params: (obj.params as Record<string, unknown>) ?? {},
      };
      for (const handler of this.eventHandlers) {
        try { handler(evt); } catch { /* a bad handler must not kill the bridge */ }
      }
    }
  }

  /** Resolve once an extension is connected (or already is). */
  waitForExtension(timeoutMs = 30_000): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return Promise.resolve();
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

  /** Send a daemon→ext request and await its response. */
  call<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('bridge: no extension connected'));
    }
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
   * Used for vibe-mode UI fan-out: progress lines, ghost-cursor moves, done. */
  sendEvent(event: string, params: Record<string, unknown> = {}): void {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return; // no panel attached — fine
    try {
      ws.send(JSON.stringify({ event, params }));
    } catch {
      /* fire-and-forget */
    }
  }

  /** Send a daemon→ext response to an ext→daemon request (keyed by `rid`). */
  private respond(rid: number, result: unknown, error: string | undefined): void {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return; // socket gone; nothing to answer
    const frame = error !== undefined ? { rid, error } : { rid, result };
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      /* fire-and-forget */
    }
  }

  /** Register an ext→daemon request handler for a method (vibe-mode reverse RPC).
   * The handler's resolved value is sent back as `{rid, result}`; a throw becomes
   * `{rid, error}`. Re-registering a method replaces the prior handler. */
  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  /** Subscribe to ext→daemon events (CDP events + lifecycle). */
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
    if (this.socket) {
      try { this.socket.close(); } catch { /* already gone */ }
      this.socket = null;
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
