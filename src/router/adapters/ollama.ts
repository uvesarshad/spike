/* Rung 3 — Ollama local: the privacy floor of the ladder. $0, fully on-device,
 * works offline. available() is a fast localhost probe so the router cleanly
 * skips this rung when no Ollama daemon is listening (the common case); it only
 * costs the 300ms timeout once per candidates() pass. Supports BOTH capabilities
 * — a vision-capable model (default llama3.2-vision) does visual verdicts and
 * planning alike. */

import type { Capability, JsonRequest, ModelAdapter } from '../adapter.js';
import { extractJson } from '../adapter.js';

export interface OllamaOptions {
  /** Vision-capable model tag (must be pulled into Ollama). */
  model?: string;
  /** Base URL of the Ollama daemon. */
  baseUrl?: string;
  /** Timeout for generateJson (ms). */
  timeoutMs?: number;
}

export class OllamaAdapter implements ModelAdapter {
  readonly name: string;
  readonly rung = 3 as const;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: OllamaOptions = {}) {
    this.model = opts.model ?? 'llama3.2-vision';
    this.baseUrl = (opts.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.name = `ollama(${this.model})`;
  }

  /** Fast probe: GET /api/tags with a 300ms timeout → true on 200. Nothing
   * listening (the common case on a dev box) fails fast, no error to the caller. */
  async available(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(300),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  supports(_cap: Capability): boolean {
    return true;
  }

  async generateJson(req: JsonRequest): Promise<unknown> {
    const message: { role: string; content: string; images?: string[] } = {
      role: 'user',
      content: req.prompt,
    };
    if (req.imagePng) message.images = [req.imagePng.toString('base64')];

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [message],
        format: req.schema, // Ollama enforces this JSON schema on the output
        stream: false,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 400)}`);
    }
    const body = (await res.json()) as { message?: { content?: string } };
    return extractJson(body.message?.content ?? '');
  }
}
