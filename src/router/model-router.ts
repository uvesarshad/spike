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
  /** Total attempts made against THIS adapter before it either succeeded or gave
   * up and fell to the next rung (A20). Omitted when there was exactly one
   * attempt (the common case) so existing consumers/snapshots see no field churn;
   * present and >1 whenever the retry-with-backoff helper below kicked in. */
  attempts?: number;
  /** True iff attempts > 1 — a quick "was this rung retried" flag for report/
   * dashboard code that would rather not do the >1 check itself. */
  retried?: boolean;
}

/* ---------------------------------------------------------------------------
 * A20 — retry-with-backoff for transient adapter failures (429 / 502-504 /
 * network hiccups), tried BEFORE the ladder falls to the next rung. See
 * docs/plan/26-08-08-audit-deterministic-speed.md finding A20.
 *
 * None of today's adapters (openai-compatible.ts, byok-gemini.ts, anthropic.ts,
 * ollama.ts) throw a typed error — they all do
 * `throw new Error(\`<label>[ api][ (video)] <status>: <body>\`)`. So
 * classification below is defensive: it prefers a typed `.status`/`.code`/
 * `.retryAfterMs` property (for when an adapter is upgraded later) and falls
 * back to parsing the status code and any rate-limit hint out of the message
 * text. Gemini's real 429 body includes a RetryInfo `"retryDelay":"31s"` field,
 * which the text-based Retry-After parser below picks up even without a typed
 * property — see report for which adapters would benefit from a typed
 * RateLimitError instead of this string-sniffing.
 * ------------------------------------------------------------------------- */

export interface FailureClassification {
  /** Worth retrying the SAME adapter again (429, 502/503/504, or a connection-
   * level network error). Everything else — bad API key, other 4xx, a schema/
   * JSON-parse error, an aborted/timed-out call — fails fast to the next rung. */
  transient: boolean;
  /** Milliseconds to wait, when the error carried an explicit Retry-After-style
   * hint (typed property or a `retryDelay`/`retry-after` mention in the message).
   * Undefined means "use the policy's exponential backoff instead". */
  retryAfterMs?: number;
  /** Short tag for trace/log messages: the status code, 'network', 'retry-after-hint', or 'non-transient'. */
  reason: string;
}

const TRANSIENT_STATUS = new Set([429, 502, 503, 504]);
const NETWORK_ERROR_RE =
  /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|EPIPE|ENOTFOUND|socket hang up|network error|fetch failed/i;
/** A50 (P2): require an HTTP-context word ("status", "http", "code" — the
 * finding's own list — plus "api", the word every real adapter message
 * actually carries: "<label> api <status>: <body>", e.g. "openai api 429:
 * rate limited") to appear within a short window BEFORE the 3-digit number,
 * not just a trailing colon. The bare `\b(\d{3})\s*:` this replaces matched
 * ANYWHERE in a thrown error's message — including CLI stderr noise with no
 * HTTP status in it at all (a `file.js:429:12` stack-trace line:column, a
 * package/build line that happens to end in "<3 digits>:"), silently
 * misclassifying an unrelated CLI/tool failure as a retryable 429/503. */
const STATUS_IN_MESSAGE_RE = /\b(?:status|http|code|api)\b[^\d]{0,24}(\d{3})\s*:/i;
const RETRY_AFTER_IN_MESSAGE_RE = /retry[-_ ]?(?:after|delay)["\s:]*"?(\d+(?:\.\d+)?)\s*s?/i;

/** Classify a thrown adapter error as transient (worth retrying) or not. Never
 * throws itself — worst case it returns `{ transient: false, reason: 'non-transient' }`,
 * which is the safe default (fail fast to the next rung). */
export function classifyFailure(err: unknown): FailureClassification {
  const e = err as
    | {
        status?: number;
        code?: string;
        cause?: { code?: string };
        retryAfterMs?: number;
        retryAfter?: number | string;
        message?: string;
      }
    | null
    | undefined;
  const message = e && typeof e.message === 'string' ? e.message : String(err);

  // 1. Explicit typed hint — no adapter sets this today, but a future typed
  // RateLimitError could, and it should win over any text sniffing.
  if (typeof e?.retryAfterMs === 'number' && Number.isFinite(e.retryAfterMs)) {
    return { transient: true, retryAfterMs: Math.max(0, e.retryAfterMs), reason: 'retry-after-hint' };
  }
  if (e?.retryAfter !== undefined) {
    const seconds = typeof e.retryAfter === 'number' ? e.retryAfter : Number(e.retryAfter);
    if (Number.isFinite(seconds)) {
      return { transient: true, retryAfterMs: Math.max(0, seconds * 1000), reason: 'retry-after-hint' };
    }
  }

  // 2. HTTP status — typed property first, else best-effort parse of the
  // "<label>[ api] <status>: <body>" convention every adapter uses today.
  const statusMatch = message.match(STATUS_IN_MESSAGE_RE);
  const status = typeof e?.status === 'number' ? e.status : statusMatch ? Number(statusMatch[1]) : undefined;
  if (status !== undefined) {
    if (TRANSIENT_STATUS.has(status)) {
      return { transient: true, retryAfterMs: extractRetryAfterFromText(message), reason: String(status) };
    }
    // Any other explicit status (401/403/400/404/500/...) fails fast — a bad
    // key or a genuine client error must not stall the run waiting on retries.
    return { transient: false, reason: String(status) };
  }

  // 3. No HTTP status at all — a connection-level failure (DNS, reset, refused,
  // fetch's own "fetch failed" wrapper). AbortError/timeouts are deliberately
  // NOT matched here: a timed-out call already burned most of its budget
  // (adapters default to 120s), so retrying it risks blowing the run's clock
  // rather than saving it — let it fall straight to the next rung.
  const code = e?.code ?? e?.cause?.code;
  if ((typeof code === 'string' && NETWORK_ERROR_RE.test(code)) || NETWORK_ERROR_RE.test(message)) {
    return { transient: true, reason: 'network' };
  }

  return { transient: false, reason: 'non-transient' };
}

/** A50 (P2): true when the thrown error is a schema/JSON-parse failure — a
 * one-off "the model didn't emit valid JSON this time" hiccup, not a real
 * HTTP/network failure. `classifyFailure`'s `transient` deliberately does NOT
 * cover this case (retrying with backoff/jitter is the wrong tool for a parse
 * error — there's nothing to wait out), but immediately falling to a
 * DIFFERENT — possibly worse or more expensive — rung on the model's first
 * malformed reply is wasteful when a bare retry of the exact same call very
 * often just works. Matches adapter.ts's `extractJson()` throw text, the one
 * place in this codebase that raises this specific failure. */
function isSchemaParseError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /model output contained no parseable JSON/i.test(message);
}

function extractRetryAfterFromText(message: string): number | undefined {
  const m = message.match(RETRY_AFTER_IN_MESSAGE_RE);
  if (!m) return undefined;
  const seconds = Number(m[1]);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined;
}

export interface RetryPolicy {
  /** Total attempts against one adapter before giving up on it (first try + retries). */
  maxAttempts: number;
  /** Base backoff delay (ms) per retry index, before jitter; the last entry is
   * reused if maxAttempts - 1 exceeds this list's length. */
  baseDelaysMs: number[];
  /** Hard ceiling on total time spent backing off ONE adapter, across all its
   * retries — keeps a stuck/slow-to-recover provider from eating the run's
   * budget. Well under the adapters' 120s call timeout and loop.ts's
   * LLM_CALL_TIMEOUT_MS (130s): this is backoff-between-calls, not the calls
   * themselves. */
  maxTotalDelayMs: number;
}

/** ~250ms, ~750ms, ~2s (+/-25% jitter), capped at 3 attempts and 4s of total
 * added latency per adapter — a few seconds, not minutes. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelaysMs: [250, 750, 2000],
  maxTotalDelayMs: 4000,
};

function jitter(ms: number): number {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run `fn`, retrying in place on a transient failure per `policy`, before
 * giving up (the caller then falls to the next rung). `attempts.count` is
 * updated live so the caller can read it even when this throws. Non-transient
 * failures (bad key, schema error, any non-429 4xx) throw on the FIRST try —
 * zero added latency, matching the "fail fast to the next rung" requirement. */
async function callWithRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  attempts: { count: number },
): Promise<T> {
  attempts.count = 0;
  let totalDelay = 0;
  for (;;) {
    attempts.count++;
    try {
      return await fn();
    } catch (e) {
      const classification = classifyFailure(e);
      if (!classification.transient || attempts.count >= policy.maxAttempts) throw e;
      const remaining = policy.maxTotalDelayMs - totalDelay;
      if (remaining <= 25) throw e; // no backoff budget left — fall to next rung now
      const base =
        classification.retryAfterMs ??
        policy.baseDelaysMs[Math.min(attempts.count - 1, policy.baseDelaysMs.length - 1)];
      const delay = Math.min(classification.retryAfterMs !== undefined ? base : jitter(base), remaining);
      totalDelay += delay;
      await sleep(delay);
    }
  }
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
  /** Override the default retry-with-backoff policy (A20). Partial — any field
   * left out keeps DEFAULT_RETRY_POLICY's value. Mainly a test seam (tiny
   * delays for fast, deterministic retry tests); production code should rely
   * on the default. */
  retryPolicy?: Partial<RetryPolicy>;
}

/** One ladder rung's live state — see ModelRouter.probeLadder (A21). */
export interface LadderAdapterStatus {
  name: string;
  rung: 0 | 1 | 2 | 3;
  available: boolean;
  capabilities: Capability[];
}

export interface LadderStatus {
  /** Adapter NAME leading plan-step (the navigator role), if pinned. */
  navigatorPin?: string;
  /** Adapter NAME leading plan-goals (the brain role), if pinned. */
  brainPin?: string;
  adapters: LadderAdapterStatus[];
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
  private readonly retryPolicy: RetryPolicy;

  constructor(private readonly adapters: ModelAdapter[], opts?: ModelRouterOptions) {
    this.adapters = [...adapters].sort((a, b) => a.rung - b.rung);
    this.preferFreePlanner = opts?.preferFreePlanner ?? false;
    this.pinnedAdapter = opts?.pinnedAdapter;
    this.navigatorAdapter = opts?.navigatorAdapter;
    this.plannerAdapter = opts?.plannerAdapter;
    this.retryPolicy = { ...DEFAULT_RETRY_POLICY, ...opts?.retryPolicy };
  }

  /** True when at least one adapter can serve `cap` right now (availability-probed
   * in parallel). The driver uses this to detect whether a BRAIN (plan-goals) is
   * configured at all — if not, it runs navigator-only with a single implicit goal
   * instead of failing the run. */
  async hasCapability(cap: Capability): Promise<boolean> {
    return (await this.candidates(cap)).length > 0;
  }

  /** A21 (`spike doctor`): the ladder as it stands right now — every adapter,
   * its live `available()` result, what it can do, and which role pin (if any)
   * names it. READ-ONLY: it probes availability and nothing else, never runs a
   * generateJson call and never mutates router state. A pin that no adapter
   * carries (e.g. the on-device navigator default, which is not a ladder
   * adapter) still comes back in `navigatorPin`/`brainPin` so the caller can
   * report the user's actual choice rather than silently showing the fallback. */
  async probeLadder(): Promise<LadderStatus> {
    const probes = await Promise.all(
      this.adapters.map(async (a): Promise<LadderAdapterStatus> => ({
        name: a.name,
        rung: a.rung,
        available: await a.available().catch(() => false),
        capabilities: (['visual-verdict', 'plan-step', 'plan-goals'] as Capability[]).filter((c) => a.supports(c)),
      })),
    );
    return {
      navigatorPin: this.effectivePin('plan-step'),
      brainPin: this.effectivePin('plan-goals'),
      adapters: probes,
    };
  }

  /** Which pin leads the ladder for a role. plan-step → navigator, plan-goals →
   * planner, each falling back to the back-compat pinnedAdapter; visual-verdict
   * keeps pinnedAdapter behind the always-first rung-0 Nano. */
  private effectivePin(cap: Capability): string | undefined {
    if (cap === 'plan-step') return this.navigatorAdapter ?? this.pinnedAdapter;
    if (cap === 'plan-goals') return this.plannerAdapter ?? this.pinnedAdapter;
    return this.pinnedAdapter;
  }

  /** A13: which adapter will ACTUALLY lead `cap` — as opposed to what the user
   * pinned. A pin that isn't among the live candidates (a model with no key,
   * a CLI that isn't installed, the on-device model on a machine that can't
   * run it) is simply dropped by candidates(), and the ladder falls through to
   * something else. Showing the pin in that situation tells the user a model
   * is driving that isn't, and hides the fact that a paid one is. undefined
   * means nothing at all can serve the role. */
  async resolveLead(cap: Capability): Promise<string | undefined> {
    const ladder = await this.candidates(cap);
    return ladder[0]?.name;
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
      const attempts = { count: 0 };
      try {
        // rung 0 takes the bare expectation (runner builds its own prompt);
        // higher rungs get the full QA prompt
        const prompt = adapter.rung === 0 ? expectation : verdictPrompt(expectation);
        const raw = (await callWithRetry(
          () =>
            this.traceCall('visual-verdict', adapter, step, () =>
              adapter.generateJson({ prompt, schema: VERDICT_JSON_SCHEMA, imagePng: png }),
            ),
          this.retryPolicy,
          attempts,
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
          attempts: attempts.count > 1 ? attempts.count : undefined,
          retried: attempts.count > 1 ? true : undefined,
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
          attempts: attempts.count > 1 ? attempts.count : undefined,
          retried: attempts.count > 1 ? true : undefined,
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
    const attempts = { count: 0 };
    try {
      const raw = (await callWithRetry(
        () => this.traceCall('visual-verdict', adapter, step, () => adapter.videoVerdict!(videoPath, expectation)),
        this.retryPolicy,
        attempts,
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
        attempts: attempts.count > 1 ? attempts.count : undefined,
        retried: attempts.count > 1 ? true : undefined,
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
        attempts: attempts.count > 1 ? attempts.count : undefined,
        retried: attempts.count > 1 ? true : undefined,
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
    const attempts = { count: 0 };
    try {
      const prompt = adapter.rung === 0 ? expectation : verdictPrompt(expectation);
      const raw = (await callWithRetry(
        () =>
          this.traceCall('visual-verdict', adapter, step, () =>
            adapter.generateJson({ prompt, schema: VERDICT_JSON_SCHEMA, imagePng: png }),
          ),
        this.retryPolicy,
        attempts,
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
        attempts: attempts.count > 1 ? attempts.count : undefined,
        retried: attempts.count > 1 ? true : undefined,
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
        attempts: attempts.count > 1 ? attempts.count : undefined,
        retried: attempts.count > 1 ? true : undefined,
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
      // A13: the old text pointed at the Google CLI's free quota, which ended on
      // 2026-06-18 — following it got the user nowhere. Name the routes that
      // actually work today.
      throw new Error(
        'no planner available — install the claude or codex CLI, or set ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY',
      );
    }
    let lastError: Error | null = null;
    let escalatedFrom: string | undefined;
    for (const adapter of ladder) {
      // A50 (P2): a schema/JSON-parse failure (the model's reply just didn't
      // parse THIS time) gets ONE same-rung retry before this adapter is
      // abandoned for the next rung down — see isSchemaParseError's doc
      // comment for why that's a different failure class than the
      // transient-HTTP retry callWithRetry already handles internally.
      let schemaRetried = false;
      for (;;) {
        const t0 = Date.now();
        const attempts = { count: 0 };
        try {
          const result = await callWithRetry(
            () => this.traceCall(cap, adapter, step, () => adapter.generateJson({ prompt, schema })),
            this.retryPolicy,
            attempts,
          );
          this.trace.push({
            step,
            capability: cap,
            rung: adapter.rung,
            adapter: adapter.name,
            ms: Date.now() - t0,
            escalatedFrom,
            usage: adapter.lastUsage,
            attempts: attempts.count > 1 ? attempts.count : undefined,
            retried: attempts.count > 1 ? true : undefined,
          });
          return result;
        } catch (e) {
          lastError = e instanceof Error ? e : new Error(String(e));
          if (!schemaRetried && isSchemaParseError(lastError)) {
            schemaRetried = true;
            this.trace.push({
              step,
              capability: cap,
              rung: adapter.rung,
              adapter: adapter.name,
              ms: Date.now() - t0,
              escalatedFrom,
              note: `schema/parse error → same-rung retry: ${lastError.message.slice(0, 120)}`,
              attempts: attempts.count > 1 ? attempts.count : undefined,
              retried: attempts.count > 1 ? true : undefined,
            });
            continue; // one more attempt against the SAME adapter, not the next rung
          }
          this.trace.push({
            step,
            capability: cap,
            rung: adapter.rung,
            adapter: adapter.name,
            ms: Date.now() - t0,
            escalatedFrom,
            note: `error → escalate: ${lastError.message.slice(0, 120)}`,
            attempts: attempts.count > 1 ? attempts.count : undefined,
            retried: attempts.count > 1 ? true : undefined,
          });
          escalatedFrom = adapter.name;
          break; // fall through to the next adapter in the ladder
        }
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
