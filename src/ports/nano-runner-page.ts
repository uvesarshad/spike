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
import { ensureChrome, evalIn, sleep } from '../chrome/launch.js';
import { RUNNER_HTML, RUNNER_JS } from './runner-assets.js';
import type { NanoAvailability, NanoPort, NanoVerdict } from './nano-port.js';

export interface NanoRunnerOptions {
  cdpPort: number;
  runnerPort: number;
  profileDir: string;
}

export class NanoRunnerPage implements NanoPort {
  private server: http.Server | null = null;
  private client: CDP.Client | null = null;
  private tabId: string | null = null;

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

    this.server = http
      .createServer((req, res) => {
        if (req.url === '/runner.js') {
          res.setHeader('content-type', 'text/javascript');
          res.end(RUNNER_JS);
        } else {
          res.setHeader('content-type', 'text/html');
          res.end(RUNNER_HTML);
        }
      })
      .listen(this.opts.runnerPort);
    await new Promise<void>((resolve, reject) => {
      this.server!.once('listening', resolve);
      this.server!.once('error', reject);
    });

    await ensureChrome({
      port: this.opts.cdpPort,
      profileDir: this.opts.profileDir,
      headless: false, // see header comment
    });

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
  }

  async availability(): Promise<NanoAvailability> {
    return evalIn<NanoAvailability>(this.c, 'window.nano.avail()');
  }

  async ensureModel(onProgress?: (status: string) => void): Promise<NanoAvailability> {
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
  }

  async warmup(): Promise<void> {
    await evalIn(this.c, 'window.nano.warmup()', { timeout: 120_000 });
  }

  async verdict(png: Buffer, task: string): Promise<{ verdict: NanoVerdict; ms: number }> {
    const dataUrl = 'data:image/png;base64,' + png.toString('base64');
    return evalIn<{ verdict: NanoVerdict; ms: number }>(
      this.c,
      `window.nano.verdict(${JSON.stringify(dataUrl)}, ${JSON.stringify(task)})`,
      { timeout: 5 * 60 * 1000 },
    );
  }

  /** Disconnect, leaving the tab + Chrome alive so the model stays warm. */
  async close(): Promise<void> {
    if (this.client) {
      try { await this.client.close(); } catch { /* already closed */ }
      this.client = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private unavailableHint(a: NanoAvailability): string {
    if (a === 'api-missing') {
      return 'Prompt API not exposed — need desktop Chrome 138+ (multimodal: 148+) on a secure context.';
    }
    const free = freeGiBOnVolume(this.opts.profileDir);
    const storage =
      free !== null && free < 22
        ? ` Likely cause: Gemini Nano needs 22 GB free on the volume holding the Chrome profile, and ${path.parse(path.resolve(this.opts.profileDir)).root} has only ${free.toFixed(1)} GB free. Move the profile (QA_CHROME_PROFILE) to a roomier volume.`
        : ' Check chrome://on-device-internals for the exact gate (storage, GPU, or platform).';
    return `Gemini Nano reports 'unavailable'.${storage}`;
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
