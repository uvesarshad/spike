/* Claude — Anthropic Messages API (BYOK). Sibling of byok-gemini.ts: raw fetch
 * (no SDK dep, matching the rest of the router), image as a base64 content block,
 * JSON steered in-prompt + parsed with extractJson. Default model is the cheapest
 * current Haiku (claude-haiku-4-5) so the "CLI/cheap model" expectation holds for
 * the API path too. Unavailable (cleanly) when no key is configured. */

import type { AdapterUsage, Capability, JsonRequest, ModelAdapter } from '../adapter.js';
import { extractJson, withSchemaInstruction } from '../adapter.js';

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
      throw new Error(`anthropic api ${res.status}: ${(await res.text()).slice(0, 400)}`);
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
