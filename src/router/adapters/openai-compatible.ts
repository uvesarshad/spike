/* OpenAI-compatible chat-completions adapter (BYOK). One class, two providers:
 *  - GPT:        baseUrl https://api.openai.com/v1   (default gpt-4o-mini)
 *  - OpenRouter: baseUrl https://openrouter.ai/api/v1 (default anthropic/claude-3.5-haiku)
 * Both speak /chat/completions with an image as an image_url data-URL and
 * response_format json_object to force syntactically-valid JSON; the schema is
 * still steered in-prompt and the reply parsed with extractJson (json_object
 * guarantees JSON, not our shape). Unavailable (cleanly) when no key is set. */

import type { AdapterUsage, Capability, JsonRequest, ModelAdapter } from '../adapter.js';
import { extractJson, withSchemaInstruction } from '../adapter.js';

export interface OpenAiCompatibleOptions {
  apiKey?: string;
  model: string;
  /** API base, e.g. https://api.openai.com/v1 or https://openrouter.ai/api/v1 . */
  baseUrl: string;
  /** Short provider label used in the adapter name + error messages ('gpt', 'openrouter'). */
  label: string;
  /** Extra headers (OpenRouter likes HTTP-Referer / X-Title; optional). */
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
}

export class OpenAiCompatibleAdapter implements ModelAdapter {
  readonly name: string;
  readonly rung = 2 as const;
  lastUsage?: AdapterUsage;

  constructor(private readonly opts: OpenAiCompatibleOptions) {
    this.name = `${opts.label}(${opts.model})`;
  }

  async available(): Promise<boolean> {
    return Boolean(this.opts.apiKey);
  }

  supports(_cap: Capability): boolean {
    return true; // mini-class vision models plan and judge screenshots
  }

  async generateJson(req: JsonRequest): Promise<unknown> {
    if (!this.opts.apiKey) throw new Error(`${this.opts.label}: no API key configured`);
    this.lastUsage = undefined; // reset; set only when usage comes back
    const userContent: object[] = [
      { type: 'text', text: withSchemaInstruction(req.prompt, req.schema) },
    ];
    if (req.imagePng) {
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
        response_format: { type: 'json_object' },
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
