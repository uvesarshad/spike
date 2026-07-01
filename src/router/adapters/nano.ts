/* Rung 0 — Gemini Nano in Chrome ($0, on-device). Two roles:
 *  - visual-verdict (always): judge a screenshot against an expectation;
 *  - plan-step (the cheap NAVIGATOR): pick ONE action from the a11y text.
 * It NEVER does plan-goals — a 3B-class model can spot the next click but
 * shouldn't design the whole multi-step plan (that's the smart BRAIN's job). */

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
    return cap === 'visual-verdict' || cap === 'plan-step';
  }

  async generateJson(req: JsonRequest): Promise<unknown> {
    // visual-verdict: an image is present. The runner page enforces its own verdict
    // schema via responseConstraint; req.prompt is the QA question ("expectation").
    if (req.imagePng) {
      const { verdict } = await this.nano.verdict(req.imagePng, req.prompt);
      return verdict;
    }
    // plan-step (navigator): no image — pick the next action from the a11y text.
    // req.prompt is the full navigator prompt; req.schema constrains the output.
    return this.nano.navStep(req.prompt, req.schema);
  }
}
