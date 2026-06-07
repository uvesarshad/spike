/* ModelRouter — walks the ladder. Cheap rung first, escalate only on
 * uncertainty or failure; every decision lands in the trace, which feeds both
 * report.model_trace and the "$0 common case" benchmark story. */

import type { NanoVerdict } from '../ports/nano-port.js';
import type { AdapterUsage, Capability, ModelAdapter } from './adapter.js';
import { VERDICT_JSON_SCHEMA, verdictPrompt } from './verdict.js';

export interface ModelTraceEntry {
  step: number;
  capability: Capability;
  rung: number;
  adapter: string;
  ms: number;
  escalatedFrom?: string;
  note?: string;
  /** Token counts for this call, when the adapter reported any (rung 0/local
   * adapters leave it undefined). Copied from adapter.lastUsage post-call. */
  usage?: AdapterUsage;
}

export class ModelRouter {
  readonly trace: ModelTraceEntry[] = [];

  constructor(private readonly adapters: ModelAdapter[]) {
    this.adapters = [...adapters].sort((a, b) => a.rung - b.rung);
  }

  private async candidates(cap: Capability): Promise<ModelAdapter[]> {
    const out: ModelAdapter[] = [];
    for (const a of this.adapters) {
      if (a.supports(cap) && (await a.available())) out.push(a);
    }
    return out;
  }

  /** Visual assertion: rung 0 first; an `uncertain` verdict escalates to the next rung. */
  async visualVerdict(png: Buffer, expectation: string, step: number): Promise<NanoVerdict> {
    const ladder = await this.candidates('visual-verdict');
    if (ladder.length === 0) throw new Error('no visual-verdict adapter available');

    let lastError: Error | null = null;
    let escalatedFrom: string | undefined;
    let lastUncertain: NanoVerdict | null = null;

    for (const adapter of ladder) {
      const t0 = Date.now();
      try {
        // rung 0 takes the bare expectation (runner builds its own prompt);
        // higher rungs get the full QA prompt
        const prompt = adapter.rung === 0 ? expectation : verdictPrompt(expectation);
        const raw = (await adapter.generateJson({
          prompt,
          schema: VERDICT_JSON_SCHEMA,
          imagePng: png,
        })) as Partial<NanoVerdict>;
        const verdict: NanoVerdict = {
          verdict: raw.verdict === 'pass' || raw.verdict === 'fail' ? raw.verdict : 'uncertain',
          summary: raw.summary ?? '',
          issues: Array.isArray(raw.issues) ? raw.issues : [],
        };
        this.trace.push({
          step,
          capability: 'visual-verdict',
          rung: adapter.rung,
          adapter: adapter.name,
          ms: Date.now() - t0,
          escalatedFrom,
          note: verdict.verdict === 'uncertain' ? 'uncertain → escalate' : undefined,
          usage: adapter.lastUsage,
        });
        if (verdict.verdict !== 'uncertain') return verdict;
        lastUncertain = verdict;
        escalatedFrom = adapter.name;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        this.trace.push({
          step,
          capability: 'visual-verdict',
          rung: adapter.rung,
          adapter: adapter.name,
          ms: Date.now() - t0,
          escalatedFrom,
          note: `error → escalate: ${lastError.message.slice(0, 120)}`,
        });
        escalatedFrom = adapter.name;
      }
    }
    if (lastUncertain) return lastUncertain; // whole ladder uncertain — honest answer
    throw new Error(`all visual-verdict adapters failed: ${lastError?.message}`);
  }

  /** Planning: rung 1 by default (rung 0 never plans); falls down-ladder on errors. */
  async planJson(prompt: string, schema: object, step: number): Promise<unknown> {
    const ladder = await this.candidates('plan-step');
    if (ladder.length === 0) {
      throw new Error(
        'no planner available — install the Google CLI (free quota) or set GEMINI_API_KEY (BYOK)',
      );
    }
    let lastError: Error | null = null;
    let escalatedFrom: string | undefined;
    for (const adapter of ladder) {
      const t0 = Date.now();
      try {
        const result = await adapter.generateJson({ prompt, schema });
        this.trace.push({
          step,
          capability: 'plan-step',
          rung: adapter.rung,
          adapter: adapter.name,
          ms: Date.now() - t0,
          escalatedFrom,
          usage: adapter.lastUsage,
        });
        return result;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        this.trace.push({
          step,
          capability: 'plan-step',
          rung: adapter.rung,
          adapter: adapter.name,
          ms: Date.now() - t0,
          escalatedFrom,
          note: `error → escalate: ${lastError.message.slice(0, 120)}`,
        });
        escalatedFrom = adapter.name;
      }
    }
    throw new Error(`all planner adapters failed: ${lastError?.message}`);
  }
}
