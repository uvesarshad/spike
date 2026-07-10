/* ModelRouter — walks the ladder. Cheap rung first, escalate only on
 * uncertainty or failure; every decision lands in the trace, which feeds both
 * report.model_trace and the "$0 common case" benchmark story. */

import type { NanoVerdict } from '../ports/nano-port.js';
import type { AdapterUsage, Capability, ModelAdapter } from './adapter.js';
import { VERDICT_JSON_SCHEMA, verdictPrompt } from './verdict.js';
import { getDefaultTracer } from '../telemetry/env.js';

export interface VisualCandidate {
  name: string;
  rung: number;
}

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

export interface ModelRouterOptions {
  /** Keep rung-1 (free Google CLI) first for planning even when a rung-2 BYOK
   * adapter is available. Default false: a configured key IS the opt-in to spend
   * it for ~3× faster planning, so the router orders rung 2 before rung 1 for
   * BOTH planner roles (plan-step AND plan-goals). Visual verdicts are never
   * reordered (rung 0 always first). Ignored for a role once that role is pinned. */
  preferFreePlanner?: boolean;
  /** Back-compat single pin: the adapter NAME used for BOTH planner roles when
   * the role-specific pins below are absent. Overrides the rung ordering AND
   * preferFreePlanner for plan-step/plan-goals. For visual-verdict, rung-0 Nano
   * still leads (it's $0/on-device), then this pin, then the rest. */
  pinnedAdapter?: string;
  /** NAVIGATOR pin — the adapter NAME leading the ladder for plan-step (the cheap
   * per-step call). Falls back to pinnedAdapter when unset. */
  navigatorAdapter?: string;
  /** BRAIN pin — the adapter NAME leading the ladder for plan-goals (the rare
   * smart planning/re-plan call). Falls back to pinnedAdapter when unset. */
  plannerAdapter?: string;
}

export class ModelRouter {
  readonly trace: ModelTraceEntry[] = [];
  /** Process-wide telemetry tracer (no-op sink by default → zero external calls
   * / zero behaviour change). Emits one `model.call` span per adapter INVOCATION
   * — including down-ladder fallback attempts — so a tracing backend sees the
   * full run→loop→model.call tree, complementing report.model_trace. */
  private readonly tracer = getDefaultTracer();
  private readonly preferFreePlanner: boolean;
  private readonly pinnedAdapter?: string;
  private readonly navigatorAdapter?: string;
  private readonly plannerAdapter?: string;

  constructor(private readonly adapters: ModelAdapter[], opts?: ModelRouterOptions) {
    this.adapters = [...adapters].sort((a, b) => a.rung - b.rung);
    this.preferFreePlanner = opts?.preferFreePlanner ?? false;
    this.pinnedAdapter = opts?.pinnedAdapter;
    this.navigatorAdapter = opts?.navigatorAdapter;
    this.plannerAdapter = opts?.plannerAdapter;
  }

  /** True when at least one adapter can serve `cap` right now (availability-probed
   * in parallel). The driver uses this to detect whether a BRAIN (plan-goals) is
   * configured at all — if not, it runs navigator-only with a single implicit goal
   * instead of failing the run. */
  async hasCapability(cap: Capability): Promise<boolean> {
    return (await this.candidates(cap)).length > 0;
  }

  /** Which pin leads the ladder for a role. plan-step → navigator, plan-goals →
   * planner, each falling back to the back-compat pinnedAdapter; visual-verdict
   * keeps pinnedAdapter behind the always-first rung-0 Nano. */
  private effectivePin(cap: Capability): string | undefined {
    if (cap === 'plan-step') return this.navigatorAdapter ?? this.pinnedAdapter;
    if (cap === 'plan-goals') return this.plannerAdapter ?? this.pinnedAdapter;
    return this.pinnedAdapter;
  }

  private async candidates(cap: Capability): Promise<ModelAdapter[]> {
    // Probe availability in PARALLEL (the ladder is ~9 adapters; serial awaits —
    // some spawning a CLI or doing a localhost fetch — needlessly stack up). Order
    // is preserved from this.adapters (already rung-sorted); a throwing available()
    // counts as unavailable rather than failing the whole step.
    const supported = this.adapters.filter((a) => a.supports(cap));
    const ready = await Promise.all(supported.map((a) => a.available().catch(() => false)));
    const out = supported.filter((_, i) => ready[i]);
    // Role pin (the user's chosen navigator/brain, or the back-compat single pin):
    // lead the ladder with it, keeping the rest in rung order behind. For
    // visual-verdict, rung-0 Nano stays absolute-first ($0/on-device); the pin
    // slots in right after it.
    const pin = this.effectivePin(cap);
    if (pin && out.some((a) => a.name === pin)) {
      out.sort((a, b) => this.pinRank(a, cap, pin) - this.pinRank(b, cap, pin));
      return out;
    }
    // planner fast path (plan-step + plan-goals): when a rung-2 BYOK adapter is
    // live and the user hasn't opted back into free quota, promote rung 2 ahead of
    // rung 1 (HTTP beats the CLI cold-spawn ~3×). Stable within rung; rung 0 (never
    // a planner) untouched; visual-verdict ladder is never reordered. Errors still
    // fall down the rest.
    if (
      (cap === 'plan-step' || cap === 'plan-goals') &&
      !this.preferFreePlanner &&
      out.some((a) => a.rung === 2)
    ) {
      out.sort((a, b) => planRank(a.rung) - planRank(b.rung));
    }
    return out;
  }

  /** Sort key when a pin is active: lower comes first. Nano keeps the visual lead;
   * the role pin leads otherwise; everyone else stays in rung order behind. */
  private pinRank(a: ModelAdapter, cap: Capability, pin: string | undefined): number {
    if (cap === 'visual-verdict' && a.rung === 0) return -2; // Nano: $0 visual, always first
    if (a.name === pin) return -1;
    return a.rung;
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
        const raw = (await this.traceCall('visual-verdict', adapter, step, () =>
          adapter.generateJson({ prompt, schema: VERDICT_JSON_SCHEMA, imagePng: png }),
        )) as Partial<NanoVerdict>;
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

  /** Available visual candidates in the same order visualVerdict() would use. */
  async visualVerdictCandidates(): Promise<VisualCandidate[]> {
    return (await this.candidates('visual-verdict')).map((a) => ({ name: a.name, rung: a.rung }));
  }

  /** True iff a video-capable visual adapter is configured AND available right
   * now. The driver gates `assert_visual { mode: 'video' }` on cfg.videoAssertions
   * FIRST, then calls this to decide whether to actually record/upload a clip or
   * fall back to the screenshot path with a report note. */
  async hasVideoVerdict(): Promise<boolean> {
    const ladder = await this.candidates('visual-verdict');
    return ladder.some((a) => a.supportsVideo && typeof a.videoVerdict === 'function');
  }

  /** Judge a recorded clip on disk. Picks the FIRST available visual-verdict
   * candidate (same ladder/pin ordering as visualVerdict()) that declares
   * supportsVideo. Returns the same NanoVerdict shape visualVerdict() returns.
   * Throws when no candidate supports video — callers (the driver) catch this
   * and fall back to a screenshot verdict rather than fail the run. */
  async videoVerdict(videoPath: string, expectation: string, step: number): Promise<NanoVerdict> {
    const ladder = await this.candidates('visual-verdict');
    const adapter = ladder.find((a) => a.supportsVideo && typeof a.videoVerdict === 'function');
    if (!adapter || !adapter.videoVerdict) {
      throw new Error('no video-capable visual-verdict adapter available');
    }
    const t0 = Date.now();
    try {
      const raw = (await this.traceCall('visual-verdict', adapter, step, () =>
        adapter.videoVerdict!(videoPath, expectation),
      )) as Partial<NanoVerdict>;
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
        note: 'video',
        usage: adapter.lastUsage,
      });
      return verdict;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.trace.push({
        step,
        capability: 'visual-verdict',
        rung: adapter.rung,
        adapter: adapter.name,
        ms: Date.now() - t0,
        note: `video error: ${err.message.slice(0, 120)}`,
      });
      throw err;
    }
  }

  /** Call a specific visual adapter by candidate name/rung and record the normal model trace.
   * Used by assertion consensus policies that need independent primary/secondary calls. */
  async visualVerdictWith(
    candidate: VisualCandidate,
    png: Buffer,
    expectation: string,
    step: number,
    traceNote?: string,
  ): Promise<{ verdict: NanoVerdict; candidate: VisualCandidate }> {
    const ladder = await this.candidates('visual-verdict');
    const adapter = ladder.find((a) => a.name === candidate.name && a.rung === candidate.rung);
    if (!adapter) throw new Error(`visual-verdict adapter unavailable: ${candidate.name}`);
    const t0 = Date.now();
    try {
      const prompt = adapter.rung === 0 ? expectation : verdictPrompt(expectation);
      const raw = (await this.traceCall('visual-verdict', adapter, step, () =>
        adapter.generateJson({ prompt, schema: VERDICT_JSON_SCHEMA, imagePng: png }),
      )) as Partial<NanoVerdict>;
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
        note: traceNote,
        usage: adapter.lastUsage,
      });
      return { verdict, candidate };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.trace.push({
        step,
        capability: 'visual-verdict',
        rung: adapter.rung,
        adapter: adapter.name,
        ms: Date.now() - t0,
        note: `${traceNote ? `${traceNote}: ` : ''}error: ${err.message.slice(0, 120)}`,
      });
      throw err;
    }
  }

  /** NAVIGATOR step (cheap, called every step): ladder led by navigatorAdapter,
   * falls down-ladder on errors. Keeps the planJson name to minimise churn. */
  async planJson(prompt: string, schema: object, step: number): Promise<unknown> {
    return this.planWith('plan-step', prompt, schema, step);
  }

  /** BRAIN plan (smart, rare): the sub-goal checklist / re-plan call. Ladder led
   * by plannerAdapter; identical error-fallback + trace behaviour as planJson. */
  async planGoals(prompt: string, schema: object, step: number): Promise<unknown> {
    return this.planWith('plan-goals', prompt, schema, step);
  }

  /** Shared planning body for both roles: rung ordering per candidates(cap), rung
   * 1 by default (rung 0 never plans); falls down-ladder on errors. */
  private async planWith(
    cap: Capability,
    prompt: string,
    schema: object,
    step: number,
  ): Promise<unknown> {
    const ladder = await this.candidates(cap);
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
        const result = await this.traceCall(cap, adapter, step, () => adapter.generateJson({ prompt, schema }));
        this.trace.push({
          step,
          capability: cap,
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
          capability: cap,
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

  /** Wrap a single adapter invocation in a `model.call` telemetry span with the
   * accurate wall-clock duration. Attributes are non-secret (capability / adapter
   * name / rung / step only — never the prompt or image). On throw the span is
   * failed and the error rethrown, so the caller's existing down-ladder fallback
   * + model_trace error entry are unchanged. */
  private traceCall<T>(cap: Capability, adapter: ModelAdapter, step: number, fn: () => Promise<T>): Promise<T> {
    return this.tracer.trace('model.call', { capability: cap, adapter: adapter.name, rung: adapter.rung, step }, fn);
  }
}

/** Planning sort key when BYOK-fast is active: rung 2 first, then 1, then 3,
 * then everything else by ascending rung. (rung 0 never supports plan-step, so
 * it won't appear here.) Keeps a stable, intentional plan ladder. */
function planRank(rung: number): number {
  if (rung === 2) return 0;
  if (rung === 1) return 1;
  if (rung === 3) return 2;
  return 3 + rung;
}
