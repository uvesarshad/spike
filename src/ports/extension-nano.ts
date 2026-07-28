/* ExtensionNano — NanoPort over the MV3 extension bridge.
 *
 * Vibe mode runs in the user's own Chrome, where the daemon has no CDP page to
 * host the localhost runner (NanoRunnerPage). The extension's own access to the
 * web-exposed Prompt API (LanguageModel) is the only channel — so this port
 * relays nano.* calls to the extension (sw.js → its own SW context or an
 * offscreen document) over the WebSocket bridge.
 *
 * The extension side mirrors runner-assets.ts semantics exactly (same
 * MODEL_OPTS, VERDICT_SCHEMA, prompt text), so verdicts are identical to
 * NanoRunnerPage's. This port only marshals to/from JSON over the bridge. */

import type { BridgeServer } from '../bridge/bridge-server.js';
import type { NanoAvailability, NanoPort, NanoVerdict } from './nano-port.js';

export interface ExtensionNanoOptions {
  bridge: BridgeServer;
}

export class ExtensionNano implements NanoPort {
  constructor(private readonly opts: ExtensionNanoOptions) {}

  private get bridge(): BridgeServer {
    return this.opts.bridge;
  }

  /** Ensure the extension service worker is connected to the bridge. */
  async start(): Promise<void> {
    await this.bridge.waitForExtension();
  }

  async availability(): Promise<NanoAvailability> {
    return this.bridge.call<NanoAvailability>('nano.avail', undefined, 60_000);
  }

  /**
   * The dev profile already holds the downloaded model; triggering a ~2GB
   * download from extension mode is out of scope for now.
   */
  async ensureModel(): Promise<NanoAvailability> {
    const a = await this.availability();
    if (a === 'available') return a;
    throw new Error(
      `Gemini Nano not available in extension mode (availability: ${a}) — ` +
        'not implemented for extension mode yet — download via spike nano',
    );
  }

  async warmup(): Promise<void> {
    await this.bridge.call('nano.warmup', undefined, 120_000);
  }

  async verdict(png: Buffer, task: string): Promise<{ verdict: NanoVerdict; ms: number }> {
    const dataUrl = 'data:image/png;base64,' + png.toString('base64');
    return this.bridge.call<{ verdict: NanoVerdict; ms: number }>(
      'nano.verdict',
      { dataUrl, task },
      5 * 60 * 1000,
    );
  }

  async navStep(prompt: string, schema: object): Promise<unknown> {
    return this.bridge.call<unknown>('nano.navStep', { prompt, schema }, 2 * 60 * 1000);
  }

  /** No-op: the bridge is owned by the caller. */
  async close(): Promise<void> {
    /* intentionally empty */
  }
}
