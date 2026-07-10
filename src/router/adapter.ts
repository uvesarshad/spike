/* ModelAdapter — one rung of the model ladder. Everything the driver needs
 * reduces to "produce JSON matching this schema from this prompt (+ image)",
 * so the adapter surface is a single generateJson(). Nano is the exception
 * that proves the rule: it only does visual verdicts (its runner enforces a
 * fixed verdict schema and requires an image), hence supports(). */

/** The three model roles the router fills. visual-verdict = judge a screenshot
 * (Nano's job); plan-step = the NAVIGATOR (cheap, called every step); plan-goals
 * = the BRAIN (smart, rare — makes/repairs the sub-goal plan). Any adapter that
 * can do plan-step can also do plan-goals (same generateJson surface; only the
 * prompt/schema differ) — Nano is the one exception: visual-verdict only. */
export type Capability = 'visual-verdict' | 'plan-step' | 'plan-goals';

export interface JsonRequest {
  prompt: string;
  /** JSON schema the response must match (adapters enforce it as well as they can). */
  schema: object;
  imagePng?: Buffer;
}

/** Per-call token accounting. An adapter sets this AFTER each generateJson()
 * that has real counts to report (the router copies it into the trace right
 * after the call resolves). Optional throughout: rung-0 Nano is on-device ($0,
 * no meaningful tokens) and Ollama is local — both leave it undefined. */
export interface AdapterUsage {
  promptTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
}

export interface ModelAdapter {
  readonly name: string;
  readonly rung: 0 | 1 | 2 | 3;
  available(): Promise<boolean>;
  supports(cap: Capability): boolean;
  generateJson(req: JsonRequest): Promise<unknown>;
  /** Token usage from the MOST RECENT generateJson() call, when the adapter can
   * surface it. The router reads this immediately after each successful call. */
  lastUsage?: AdapterUsage;
  /** True when this adapter can judge an uploaded video clip, not just a still
   * screenshot (opt-in — Phase 8 video assertions, gated by cfg.videoAssertions).
   * Optional; absent/false means screenshot-only (the default for every adapter
   * except one that implements videoVerdict, e.g. ByokGeminiAdapter via the
   * Gemini Files API). Only ever set on an adapter that also supports
   * 'visual-verdict'. */
  readonly supportsVideo?: boolean;
  /** Upload (if needed) and judge a recorded clip on disk against `expectation`,
   * returning the SAME raw verdict shape generateJson() returns for a
   * visual-verdict call (the caller normalizes it into NanoVerdict, same as
   * visualVerdict()). Present iff supportsVideo is true; ModelRouter.videoVerdict()
   * throws when no candidate defines it, so callers fall back to the screenshot
   * path rather than crash the run. */
  videoVerdict?(clipPath: string, expectation: string): Promise<unknown>;
}

/** Append a "respond with ONLY this JSON shape" instruction to a prompt. The
 * driver's schemas use constructs (minItems, type-discriminated optional props)
 * that providers' strict JSON modes reject, so adapters steer with the schema
 * in-prompt and parse the reply with extractJson — the same recipe google-cli
 * proved on this repo. */
export function withSchemaInstruction(prompt: string, schema: object): string {
  return `${prompt}\n\nRespond with ONLY a JSON object matching this JSON schema:\n${JSON.stringify(schema)}`;
}

/** Pull the first JSON object out of model output that may have prose around it. */
export function extractJson(text: string): unknown {
  const direct = text.trim();
  try {
    return JSON.parse(direct);
  } catch {
    /* fall through */
  }
  const fence = direct.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* fall through */
    }
  }
  const start = direct.indexOf('{');
  if (start >= 0) {
    // walk to the matching close brace
    let depth = 0;
    for (let i = start; i < direct.length; i++) {
      if (direct[i] === '{') depth++;
      else if (direct[i] === '}' && --depth === 0) {
        try {
          return JSON.parse(direct.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  throw new Error(`model output contained no parseable JSON: ${direct.slice(0, 200)}`);
}
