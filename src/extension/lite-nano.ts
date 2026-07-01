/* LiteNano — NanoPort for LITE mode. Mirrors ExtensionNano but reaches the
 * on-device Prompt API through INJECTED service-worker callbacks instead of the
 * WebSocket bridge. The SW wires these to its existing nanoAvail/nanoWarmup/
 * nanoVerdict helpers (which already pick SW-direct vs the offscreen document),
 * so there is no new Prompt API code here — only Buffer→data-URL marshalling. */

import type { NanoAvailability, NanoPort, NanoVerdict } from '../ports/nano-port.js';

export interface LiteNanoDeps {
  avail(): Promise<NanoAvailability>;
  warmup(): Promise<void>;
  /** Judge a screenshot (data URL) against the QA question. */
  verdict(dataUrl: string, task: string): Promise<{ verdict: NanoVerdict; ms: number }>;
}

export class LiteNano implements NanoPort {
  constructor(private readonly deps: LiteNanoDeps) {}

  async start(): Promise<void> {
    /* nothing to connect — the SW owns the offscreen doc */
  }

  async availability(): Promise<NanoAvailability> {
    return this.deps.avail();
  }

  async ensureModel(): Promise<NanoAvailability> {
    const a = await this.availability();
    if (a === 'available') return a;
    throw new Error(`Gemini Nano not available (availability: ${a})`);
  }

  async warmup(): Promise<void> {
    await this.deps.warmup();
  }

  async verdict(png: Buffer, task: string): Promise<{ verdict: NanoVerdict; ms: number }> {
    const dataUrl = 'data:image/png;base64,' + png.toString('base64');
    return this.deps.verdict(dataUrl, task);
  }

  async close(): Promise<void> {
    /* intentionally empty */
  }
}
