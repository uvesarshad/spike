/* Rung 0 — Gemini Nano in Chrome. Visual verdicts only ($0, on-device);
 * never plans (a 3B-class model shouldn't drive multi-step flows). */

import type { NanoPort } from '../../ports/nano-port.js';
import type { Capability, JsonRequest, ModelAdapter } from '../adapter.js';

export class NanoAdapter implements ModelAdapter {
  readonly name = 'nano';
  readonly rung = 0 as const;

  constructor(private readonly nano: NanoPort) {}

  async available(): Promise<boolean> {
    try {
      return (await this.nano.availability()) === 'available';
    } catch {
      return false;
    }
  }

  supports(cap: Capability): boolean {
    return cap === 'visual-verdict';
  }

  async generateJson(req: JsonRequest): Promise<unknown> {
    if (!req.imagePng) throw new Error('nano adapter requires an image');
    // the runner page enforces its own verdict schema via responseConstraint;
    // req.prompt is the QA question ("expectation"), not a full prompt
    const { verdict } = await this.nano.verdict(req.imagePng, req.prompt);
    return verdict;
  }
}
