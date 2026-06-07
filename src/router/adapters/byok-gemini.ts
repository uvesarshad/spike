/* Rung 2 — BYOK: direct Gemini API with the user's key. The adapter shape is
 * the seam: an OpenRouter/OpenAI adapter drops in by implementing ModelAdapter
 * the same way. Unavailable (cleanly) when no key is configured. */

import type { Capability, JsonRequest, ModelAdapter } from '../adapter.js';
import { extractJson } from '../adapter.js';

export interface ByokGeminiOptions {
  apiKey?: string;
  model: string;
  timeoutMs?: number;
}

export class ByokGeminiAdapter implements ModelAdapter {
  readonly name: string;
  readonly rung = 2 as const;

  constructor(private readonly opts: ByokGeminiOptions) {
    this.name = `byok-gemini(${opts.model})`;
  }

  async available(): Promise<boolean> {
    return Boolean(this.opts.apiKey);
  }

  supports(_cap: Capability): boolean {
    return true;
  }

  async generateJson(req: JsonRequest): Promise<unknown> {
    if (!this.opts.apiKey) throw new Error('byok-gemini: no API key configured');
    const parts: object[] = [{ text: req.prompt }];
    if (req.imagePng) {
      parts.push({ inlineData: { mimeType: 'image/png', data: req.imagePng.toString('base64') } });
    }
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.opts.model}:generateContent`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.opts.apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: req.schema,
          },
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
      },
    );
    if (!res.ok) {
      throw new Error(`gemini api ${res.status}: ${(await res.text()).slice(0, 400)}`);
    }
    const body = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    return extractJson(text);
  }
}
