/* OpenAI-compatible chat-completions adapter (BYOK). One class, several providers:
 *  - GPT:        baseUrl https://api.openai.com/v1    (default gpt-4o-mini)
 *  - OpenRouter: baseUrl https://openrouter.ai/api/v1 (default anthropic/claude-3.5-haiku)
 *  - GLM (z.ai): baseUrl https://api.z.ai/api/paas/v4 (default glm-5.2, text-only)
 * All speak /chat/completions with response_format json_object to force
 * syntactically-valid JSON; the schema is still steered in-prompt and the reply
 * parsed with extractJson (json_object guarantees JSON, not our shape). A vision
 * model also takes an image as an image_url data-URL; a text-only model
 * (supportsVision:false, e.g. GLM-5.2) declares no visual-verdict support and
 * never attaches an image. extraBody passes provider-specific top-level fields
 * (e.g. GLM's thinking:{type:'disabled'} to keep the planner fast/cheap).
 * Unavailable (cleanly) when no key is set.
 *
 * Screenshot-only (Phase 8): chat-completions has no standard video-upload +
 * judge path across gpt/openrouter/glm, so this adapter never sets
 * supportsVideo/videoVerdict — a video assertion routed to gpt/openrouter/glm
 * falls back to the screenshot verdict path (see ModelRouter.videoVerdict). */

import type { AdapterUsage, Capability, JsonRequest, ModelAdapter } from '../adapter.js';
import { extractJson, withSchemaInstruction } from '../adapter.js';

export interface OpenAiCompatibleOptions {
  apiKey?: string;
  model: string;
  /** API base, e.g. https://api.openai.com/v1 or https://api.z.ai/api/paas/v4 . */
  baseUrl: string;
  /** Short provider label used in the adapter name + error messages ('gpt', 'openrouter', 'glm'). */
  label: string;
  /** Extra headers (OpenRouter likes HTTP-Referer / X-Title; optional). */
  extraHeaders?: Record<string, string>;
  /** Does this model accept image input? Default true (gpt-4o-mini and most
   * OpenRouter vision models). Set false for a text-only model (e.g. GLM-5.2):
   * the adapter then supports plan-step only and never sends an image, so the
   * router won't route a visual verdict to a model that can't see. */
  supportsVision?: boolean;
  /** Send response_format:{type:'json_object'}? Default true. A provider that
   * rejects the field can disable it and rely on in-prompt schema steering. */
  jsonMode?: boolean;
  /** Extra top-level body fields merged into the chat-completions request
   * (e.g. { thinking: { type: 'disabled' } } for GLM reasoning models). */
  extraBody?: Record<string, unknown>;
  timeoutMs?: number;
}

export class OpenAiCompatibleAdapter implements ModelAdapter {
  readonly name: string;
  readonly rung = 2 as const;
  /** Explicit false — screenshot-only (see file header): no gpt/openrouter/glm
   * route currently uploads+judges a video clip. */
  readonly supportsVideo = false;
  lastUsage?: AdapterUsage;
  private readonly supportsVision: boolean;

  constructor(private readonly opts: OpenAiCompatibleOptions) {
    this.name = `${opts.label}(${opts.model})`;
    this.supportsVision = opts.supportsVision ?? true;
  }

  async available(): Promise<boolean> {
    return Boolean(this.opts.apiKey);
  }

  supports(cap: Capability): boolean {
    // Text-only models plan from the a11y tree but can't judge a screenshot.
    return cap === 'visual-verdict' ? this.supportsVision : true;
  }

  async generateJson(req: JsonRequest): Promise<unknown> {
    if (!this.opts.apiKey) throw new Error(`${this.opts.label}: no API key configured`);
    this.lastUsage = undefined; // reset; set only when usage comes back
    const userContent: object[] = [
      { type: 'text', text: withSchemaInstruction(req.prompt, req.schema) },
    ];
    if (req.imagePng && this.supportsVision) {
      userContent.push({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${req.imagePng.toString('base64')}` },
      });
    }

    const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.opts.apiKey}`,
        ...(this.opts.extraHeaders ?? {}),
      },
      body: JSON.stringify({
        model: this.opts.model,
        messages: [{ role: 'user', content: userContent }],
        ...((this.opts.jsonMode ?? true) ? { response_format: { type: 'json_object' } } : {}),
        ...(this.opts.extraBody ?? {}),
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
    });
    if (!res.ok) {
      throw new Error(`${this.opts.label} api ${res.status}: ${(await res.text()).slice(0, 400)}`);
    }
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const u = body.usage;
    if (u) {
      const usage: AdapterUsage = {};
      if (typeof u.prompt_tokens === 'number') usage.promptTokens = u.prompt_tokens;
      if (typeof u.completion_tokens === 'number') usage.outputTokens = u.completion_tokens;
      if (typeof u.total_tokens === 'number') usage.totalTokens = u.total_tokens;
      if (Object.keys(usage).length) this.lastUsage = usage;
    }
    const text = body.choices?.[0]?.message?.content ?? '';
    return extractJson(text);
  }
}
