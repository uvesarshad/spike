/* Dev-load an unpacked MV3 extension into branded Chrome 137+ where the
 * --load-extension flag is DEAD.
 *
 * The supported replacement is the CDP command Extensions.loadUnpacked, but
 * Chrome only exposes the Extensions domain when:
 *   1. it was started with --remote-debugging-pipe (NOT --remote-debugging-port),
 *      because the Extensions domain is a "pipe-only" surface, AND
 *   2. --enable-unsafe-extension-debugging is set.
 * Over a port-based WebSocket the call returns "Method not available." — this is
 * a hard gate, confirmed against Chrome 148 and matching how Playwright/web-ext
 * do it (see bitcrowd.dev "Loading Chrome Extensions in 2025", mozilla/web-ext
 * #3388).
 *
 * Because the pipe file descriptors (fd 3 = Chrome reads, fd 4 = Chrome writes)
 * must be wired up at spawn time, this helper OWNS the Chrome process: it spawns
 * Chrome with BOTH --remote-debugging-pipe (for the one-shot loadUnpacked) AND
 * --remote-debugging-port (so the rest of the daemon keeps talking CDP over the
 * port as usual). The pipe is used only to load the extension, then left idle.
 *
 * CDP-over-pipe framing: JSON-RPC messages identical to the WebSocket protocol,
 * each message terminated by a single NUL byte (\0). */

import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { Writable, Readable } from 'node:stream';
import { findChrome, sleep, cdpAlive } from './launch.js';

export interface LaunchWithExtensionOptions {
  /** CDP port the daemon will use for everything after load (e.g. 9325). */
  cdpPort: number;
  /** Absolute path to the unpacked extension dir (manifest.json + sw.js). */
  extensionDir: string;
  /** Absolute path to the Chrome user-data-dir. */
  profileDir: string;
  /** Headed by default; set true for --headless=new. */
  headless?: boolean;
  windowSize?: string;
}

export interface LaunchWithExtensionResult {
  extensionId: string;
  /** The owned Chrome process (already listening on cdpPort). Kill on teardown. */
  chrome: ChildProcess;
}

/** A minimal hand-rolled CDP-over-pipe client speaking to Chrome's fd 3/4. */
class PipeClient {
  private nextId = 1;
  private buf = Buffer.alloc(0);
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(private outgoing: Writable, incoming: Readable) {
    incoming.on('data', (chunk: Buffer) => this.onData(chunk));
    incoming.on('error', (e) => this.failAll(e));
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    let nul: number;
    // Messages are NUL-terminated; process every complete one in the buffer.
    while ((nul = this.buf.indexOf(0)) !== -1) {
      const slice = this.buf.subarray(0, nul);
      this.buf = this.buf.subarray(nul + 1);
      const text = slice.toString('utf8').trim();
      if (!text) continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(text);
      } catch {
        continue; // ignore non-JSON noise on the pipe
      }
      if (typeof msg.id !== 'number') continue; // event, not a command reply
      const waiter = this.pending.get(msg.id);
      if (!waiter) continue;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else waiter.resolve(msg.result);
    }
  }

  private failAll(e: Error): void {
    for (const { reject } of this.pending.values()) reject(e);
    this.pending.clear();
  }

  send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.outgoing.write(payload + '\0', (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }
}

/**
 * Launch a Chrome that owns a dev-loaded unpacked extension and listens on
 * `cdpPort` for the rest of the daemon. Returns the extension id and the owned
 * Chrome process (kill it on teardown).
 *
 * Note: shaped as a launcher (not a `loadUnpackedExtension(port)` against an
 * existing Chrome) on purpose — the pipe fds for Extensions.loadUnpacked must be
 * established at spawn time, so this helper must spawn Chrome itself.
 */
export async function launchChromeWithExtension(
  opts: LaunchWithExtensionOptions,
): Promise<LaunchWithExtensionResult> {
  if (!fs.existsSync(opts.extensionDir)) {
    throw new Error(`extension dir not found: ${opts.extensionDir}`);
  }

  const args = [
    '--remote-debugging-pipe', // fd 3/4 — REQUIRED for Extensions domain
    `--remote-debugging-port=${opts.cdpPort}`, // for the rest of the daemon
    `--user-data-dir=${opts.profileDir}`,
    '--enable-unsafe-extension-debugging', // unlocks Extensions.loadUnpacked
    '--silent-debugger-extension-api',
    '--no-first-run',
    '--no-default-browser-check',
    `--window-size=${opts.windowSize ?? '1366,960'}`,
  ];
  if (opts.headless) args.push('--headless=new', '--disable-gpu');
  args.push('about:blank');

  // stdio: 0/1/2 inherited-ish, fd 3 = pipe IN to Chrome (we write commands),
  // fd 4 = pipe OUT of Chrome (we read replies). 'pipe' for both.
  const chrome = spawn(findChrome(), args, {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
  });

  const toChrome = chrome.stdio[3] as Writable | null;
  const fromChrome = chrome.stdio[4] as Readable | null;
  if (!toChrome || !fromChrome) {
    try { chrome.kill(); } catch { /* gone */ }
    throw new Error('Chrome remote-debugging pipe fds (3/4) were not created');
  }

  const pipe = new PipeClient(toChrome, fromChrome);

  try {
    // Wait for the port side to come up — proves Chrome booted and lets the
    // daemon reuse it immediately after we return.
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      up = await cdpAlive(opts.cdpPort);
      if (!up) await sleep(200);
    }
    if (!up) throw new Error(`Chrome CDP port ${opts.cdpPort} never came up`);

    const { id } = await pipe.send<{ id: string }>('Extensions.loadUnpacked', {
      path: opts.extensionDir,
    });
    if (!id) throw new Error('Extensions.loadUnpacked returned no extension id');
    return { extensionId: id, chrome };
  } catch (e) {
    try { chrome.kill(); } catch { /* gone */ }
    throw e;
  }
}
