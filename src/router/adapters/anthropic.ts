/* Claude — Anthropic Messages API (BYOK). Sibling of byok-gemini.ts: raw fetch
 * (no SDK dep, matching the rest of the router), image as a base64 content block,
 * JSON steered in-prompt + parsed with extractJson. Default model is the cheapest
 * current Haiku (claude-haiku-4-5) so the "CLI/cheap model" expectation holds for
 * the API path too. Unavailable (cleanly) when no key is configured.
 *
 * Screenshot-only (Phase 8): the Messages API has no equivalent of Gemini's
 * Files-API video upload + judge path, so this adapter never sets
 * supportsVideo/videoVerdict — a video assertion routed here falls back to the
 * screenshot verdict path (see ModelRouter.videoVerdict / hasVideoVerdict). */

import type { AdapterUsage, Capability, JsonRequest, ModelAdapter } from '../adapter.js';
import { extractJson, withSchemaInstruction } from '../adapter.js';

/* A25 — attach a typed `.retryAfterMs` hint (ms) to a 429/503 error, parsed
 * from the HTTP `Retry-After` header (either a plain seconds count or an
 * HTTP-date). This feeds the SAME typed-hint path model-router.ts's
 * classifyFailure() already gives priority over its own text-sniffing (the
 * mechanism that, today, is what picks Gemini's body-embedded `retryDelay`
 * out of the error message) — see classifyFailure()'s step 1. Real
 * rate-limit guidance from the server wins over blind exponential backoff. */
function withRetryAfterHint(err: Error, res: Response): Error {
  if (res.status !== 429 && res.status !== 503) return err;
  const header = res.headers.get('retry-after');
  if (!header) return err;
  const trimmed = header.trim();
  let ms: number | undefined;
  if (/^\d+$/.test(trimmed)) {
    ms = Number(trimmed) * 1000;
  } else {
    const dateMs = Date.parse(trimmed);
    if (Number.isFinite(dateMs)) ms = dateMs - Date.now();
  }
  if (ms !== undefined && Number.isFinite(ms)) {
    (err as Error & { retryAfterMs?: number }).retryAfterMs = Math.max(0, ms);
  }
  return err;
}

export interface AnthropicOptions {
  apiKey?: string;
  model: string;
  timeoutMs?: number;
  /** LITE mode: calling the Anthropic API directly from a browser/extension
   * context is gated server-side — without this opt-in header Anthropic returns
   * a CORS error. The daemon path leaves it false. (Note: this exposes the key to
   * the page's origin context; acceptable in an extension SW where the key is the
   * user's own and never leaves their machine except to Anthropic.) */
  browserDirect?: boolean;
}

export class AnthropicAdapter implements ModelAdapter {
  readonly name: string;
  readonly rung = 2 as const;
  /** Explicit false (not just "absent") — makes the screenshot-only contract
   * checkable at the type level, e.g. `adapter.supportsVideo` reads cleanly
   * instead of needing a cast through the ModelAdapter interface. */
  readonly supportsVideo = false;
  lastUsage?: AdapterUsage;

  constructor(private readonly opts: AnthropicOptions) {
    this.name = `anthropic(${opts.model})`;
  }

  async available(): Promise<boolean> {
    return Boolean(this.opts.apiKey);
  }

  supports(_cap: Capability): boolean {
    return true; // Haiku-class: plans and judges screenshots
  }

  async generateJson(req: JsonRequest): Promise<unknown> {
    if (!this.opts.apiKey) throw new Error('anthropic: no API key configured');
    this.lastUsage = undefined; // reset; set only when usage comes back
    const content: object[] = [];
    if (req.imagePng) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: req.imagePng.toString('base64') },
      });
    }
    content.push({ type: 'text', text: withSchemaInstruction(req.prompt, req.schema) });

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.opts.apiKey,
        'anthropic-version': '2023-06-01',
        ...(this.opts.browserDirect ? { 'anthropic-dangerous-direct-browser-access': 'true' } : {}),
      },
      body: JSON.stringify({
        model: this.opts.model,
        max_tokens: 4096,
        messages: [{ role: 'user', content }],
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
    });
    if (!res.ok) {
      throw withRetryAfterHint(new Error(`anthropic api ${res.status}: ${(await res.text()).slice(0, 400)}`), res);
    }
    const body = (await res.json()) as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const u = body.usage;
    if (u) {
      const usage: AdapterUsage = {};
      if (typeof u.input_tokens === 'number') usage.promptTokens = u.input_tokens;
      if (typeof u.output_tokens === 'number') usage.outputTokens = u.output_tokens;
      if (usage.promptTokens !== undefined && usage.outputTokens !== undefined) {
        usage.totalTokens = usage.promptTokens + usage.outputTokens;
      }
      if (Object.keys(usage).length) this.lastUsage = usage;
    }
    const text = (body.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    return extractJson(text);
  }
}
