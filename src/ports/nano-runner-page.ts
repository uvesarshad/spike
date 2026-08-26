/* NanoRunnerPage — NanoPort over a localhost runner page in the daemon's Chrome.
 *
 * Lifecycle mirrors the spike: Chrome is launched detached and the runner tab is
 * left open between runs so the downloaded model and warm session survive.
 * start() reuses an existing runner tab when it finds one.
 *
 * Encoded gotchas (product doc §6.5):
 * - never navigate the runner tab while the model downloads (kills create());
 * - 'unavailable' usually means the storage gate: Nano needs 22 GB free on the
 *   volume holding the Chrome profile — we check and say so;
 * - Chrome must be HEADED: Nano availability in headless is not proven, and the
 *   daemon's Chrome doubles as the "watch the robot" window later. */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import CDP from 'chrome-remote-interface';
import { ensureChrome, evalIn, sleep, findChrome, isChromiumPath } from '../chrome/launch.js';
import { RUNNER_HTML, RUNNER_JS } from './runner-assets.js';
import type { NanoAvailability, NanoPort, NanoVerdict } from './nano-port.js';

export interface NanoRunnerOptions {
  cdpPort: number;
  runnerPort: number;
  profileDir: string;
}

/** A3 (P0): the runner HTTP server, shared PROCESS-WIDE per port and
 * refcounted. Before this, every `NanoRunnerPage.start()` unconditionally
 * called `http.createServer(...).listen(this.opts.runnerPort)` — fine when
 * calls are strictly sequential (today's default, each qaRun/qaReplay opens
 * and closes its own session before the next begins), but the exact
 * EADDRINUSE crash the audit calls out by name (finding A3: "Nano runner HTTP
 * port 9400 ... Second process throws EADDRINUSE — sharpest, loudest
 * failure") the moment two sessions overlap — which is now possible via
 * `replay --all --workers N` with `via: 'playwright'` (several concurrent
 * qaReplay calls sharing ONE Chrome on cfg.cdpPort/cfg.runnerPort by design,
 * see engine.ts's resolveNanoLaunchOpts). Keyed by port so isolated sessions
 * that allocated their OWN distinct runnerPort never share a server (and
 * never need to) — this only matters for callers pointed at the SAME port. */
const sharedServers = new Map<number, { server: http.Server; refs: number }>();

export async function acquireRunnerServer(port: number): Promise<http.Server> {
  const existing = sharedServers.get(port);
  if (existing) {
    existing.refs++;
    return existing.server;
  }
  const server = http
    .createServer((req, res) => {
      if (req.url === '/runner.js') {
        res.setHeader('content-type', 'text/javascript');
        res.end(RUNNER_JS);
      } else {
        res.setHeader('content-type', 'text/html');
        res.end(RUNNER_HTML);
      }
    })
    .listen(port);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  sharedServers.set(port, { server, refs: 1 });
  return server;
}

/** Drop this instance's reference; only actually closes the server once the
 * last referencing NanoRunnerPage on this port has released it — a single
 * `close()` must never yank the server out from under a sibling instance
 * still using the same port (see acquireRunnerServer's doc comment). */
export function releaseRunnerServer(port: number): void {
  const existing = sharedServers.get(port);
  if (!existing) return;
  existing.refs--;
  if (existing.refs <= 0) {
    existing.server.close();
    sharedServers.delete(port);
  }
}

/** A3 (P0): serialize `Runtime.evaluate` calls into the SAME runner tab,
 * keyed by cdpPort — the audit's own words: "Nano warm session — one tab, one
 * session, no lock around concurrent Runtime.evaluate calls." Two
 * NanoRunnerPage instances that share a cdpPort (the `via: 'playwright'` +
 * `--workers N` case: one shared Chrome, one shared Nano tab) each hold their
 * OWN chrome-remote-interface connection to that SAME tab, so nothing before
 * this serialized their calls into `window.nano` — a concurrent verdict()
 * and navStep() could interleave inside the page's single Prompt-API session
 * object. Distinct cdpPorts (isolated/split Chromes) never contend, so they
 * never wait on each other. */
const nanoCallLocks = new Map<number, Promise<unknown>>();

export function withNanoLock<T>(port: number, fn: () => Promise<T>): Promise<T> {
  const prior = nanoCallLocks.get(port) ?? Promise.resolve();
  const chained = prior.then(fn, fn); // run fn after prior settles either way
  // Store a version that never rejects, so a failed call doesn't wedge the
  // lock for whoever queues next — the ACTUAL result/rejection still flows to
  // this call's own caller via `chained` below.
  nanoCallLocks.set(port, chained.catch(() => undefined));
  return chained;
}

export class NanoRunnerPage implements NanoPort {
  private serverAcquired = false;
  private client: CDP.Client | null = null;
  private tabId: string | null = null;
  /** "Chromium support" enhancement: best-effort re-resolution of the same
   * candidate list ensureChrome() itself just used to launch/reuse the
   * daemon's Chrome (NanoRunnerOptions carries no chromePath today, so this
   * mirrors that exact resolution — see start() below), so unavailableHint()
   * can say WHY when it's Chromium rather than branded Chrome (the Prompt
   * API is Chrome-only). Detection failure never breaks start() — it just
   * leaves the hint generic. */
  private isChromium = false;

  constructor(private readonly opts: NanoRunnerOptions) {}

  private get c(): CDP.Client {
    if (!this.client) throw new Error('NanoRunnerPage: start() first');
    return this.client;
  }

  private runnerUrl(): string {
    return `http://localhost:${this.opts.runnerPort}/runner.html`;
  }

  async start(): Promise<void> {
    if (this.client) return;

    await acquireRunnerServer(this.opts.runnerPort);
    this.serverAcquired = true;
    try {
      await ensureChrome({
        port: this.opts.cdpPort,
        profileDir: this.opts.profileDir,
        headless: false, // see header comment
      });
      try {
        this.isChromium = isChromiumPath(findChrome());
      } catch {
        // best-effort only — never let hint detection break start()
      }

      // reuse a surviving runner tab (warm model) before opening a new one
      const targets = await CDP.List({ port: this.opts.cdpPort });
      const existing = targets.find((t) => t.url === this.runnerUrl());
      if (existing) {
        this.tabId = existing.id;
      } else {
        const created = await CDP.New({ port: this.opts.cdpPort, url: this.runnerUrl() });
        this.tabId = (created as { id?: string }).id ?? (created as { targetId?: string }).targetId!;
        await sleep(1200); // let runner.js evaluate
      }
      this.client = await CDP({ port: this.opts.cdpPort, target: this.tabId });
      await this.client.Runtime.enable();

      // make sure window.nano actually exists (fresh tab vs reused tab)
      for (let i = 0; i < 20; i++) {
        const t = await evalIn<string>(this.c, 'typeof window.nano', { userGesture: false });
        if (t === 'object') return;
        await sleep(300);
      }
      throw new Error('runner page never exposed window.nano');
    } catch (e) {
      // A3: don't leak the shared server's refcount on a failed start() — the
      // caller (engine.ts's openSession) never calls close() in this path, so
      // this is the only place that can release it.
      releaseRunnerServer(this.opts.runnerPort);
      this.serverAcquired = false;
      throw e;
    }
  }

  async availability(): Promise<NanoAvailability> {
    return evalIn<NanoAvailability>(this.c, 'window.nano.avail()');
  }

  async ensureModel(onProgress?: (status: string) => void): Promise<NanoAvailability> {
    return withNanoLock(this.opts.cdpPort, async () => {
      let a = await this.availability();
      if (a === 'available') return a;
      if (a === 'unavailable' || a === 'api-missing') {
        throw new Error(this.unavailableHint(a));
      }
      // downloadable | downloading → kick off and poll window.__status
      void evalIn(this.c, 'window.nano.download()', { timeout: 60 * 60 * 1000 }).catch(() => {
        /* surfaced via availability below */
      });
      let last = '';
      for (;;) {
        await sleep(4000);
        const s = await evalIn<string>(this.c, 'window.__status', { userGesture: false });
        if (s !== last) {
          onProgress?.(s);
          last = s;
        }
        if (s === 'download done') break;
      }
      a = await this.availability();
      if (a !== 'available') throw new Error(this.unavailableHint(a));
      return a;
    });
  }

  async warmup(): Promise<void> {
    await withNanoLock(this.opts.cdpPort, () => evalIn(this.c, 'window.nano.warmup()', { timeout: 120_000 }));
  }

  async verdict(png: Buffer, task: string): Promise<{ verdict: NanoVerdict; ms: number }> {
    const dataUrl = 'data:image/png;base64,' + png.toString('base64');
    return withNanoLock(this.opts.cdpPort, () =>
      evalIn<{ verdict: NanoVerdict; ms: number }>(
        this.c,
        `window.nano.verdict(${JSON.stringify(dataUrl)}, ${JSON.stringify(task)})`,
        { timeout: 5 * 60 * 1000 },
      ),
    );
  }

  async navStep(prompt: string, schema: object): Promise<unknown> {
    return withNanoLock(this.opts.cdpPort, () =>
      evalIn<unknown>(
        this.c,
        `window.nano.navStep(${JSON.stringify(prompt)}, ${JSON.stringify(schema)})`,
        { timeout: 2 * 60 * 1000 },
      ),
    );
  }

  /** Disconnect, leaving the tab + Chrome alive so the model stays warm. */
  async close(): Promise<void> {
    if (this.client) {
      try { await this.client.close(); } catch { /* already closed */ }
      this.client = null;
    }
    if (this.serverAcquired) {
      releaseRunnerServer(this.opts.runnerPort);
      this.serverAcquired = false;
    }
  }

  private unavailableHint(a: NanoAvailability): string {
    // "Chromium support" enhancement: Nano/the Prompt API is Chrome-only, so
    // a Chromium-launched daemon will never pass this gate no matter how
    // much free disk it has — say so up front rather than sending the user
    // chasing the storage/GPU checklist below.
    const chromiumNote = this.isChromium
      ? ' Chromium detected: Gemini Nano requires Google Chrome (the Prompt API is Chrome-only) — install branded Chrome or point SPIKE_CHROME_PATH at it.'
      : '';
    if (a === 'api-missing') {
      return `Prompt API not exposed — need desktop Chrome 138+ (multimodal: 148+) on a secure context.${chromiumNote}`;
    }
    const free = freeGiBOnVolume(this.opts.profileDir);
    const storage =
      free !== null && free < 22
        ? ` Likely cause: Gemini Nano needs 22 GB free on the volume holding the Chrome profile, and ${path.parse(path.resolve(this.opts.profileDir)).root} has only ${free.toFixed(1)} GB free. Move the profile (SPIKE_CHROME_PROFILE) to a roomier volume.`
        : ' Check chrome://on-device-internals for the exact gate (storage, GPU, or platform).';
    return `Gemini Nano reports 'unavailable'.${chromiumNote}${storage}`;
  }
}

function freeGiBOnVolume(p: string): number | null {
  try {
    const st = fs.statfsSync(path.resolve(p));
    return (st.bavail * st.bsize) / 1024 ** 3;
  } catch {
    return null;
  }
}
