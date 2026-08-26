/* Rung 3 — Ollama local: the privacy floor of the ladder. $0, fully on-device,
 * works offline. available() is a fast localhost probe so the router cleanly
 * skips this rung when no Ollama daemon is listening (the common case); it only
 * costs the 300ms timeout once per candidates() pass. Supports BOTH capabilities
 * — a vision-capable model (default llama3.2-vision) does visual verdicts and
 * planning alike. */

import type { AdapterUsage, Capability, JsonRequest, ModelAdapter } from '../adapter.js';
import { extractJson } from '../adapter.js';

/** A50 (P2): ~4 chars/token is the standard rough English-text estimator —
 * good enough for cost-accounting VISIBILITY (so this rung isn't silently
 * zero in report.model_trace / the dashboard), not for billing precision.
 * Always flagged `estimated: true` so a consumer never mistakes it for an
 * API-reported exact count. */
export function estimateUsage(promptChars: number, outputChars: number): AdapterUsage {
  const promptTokens = Math.ceil(promptChars / 4);
  const outputTokens = Math.ceil(outputChars / 4);
  return { promptTokens, outputTokens, totalTokens: promptTokens + outputTokens, estimated: true };
}

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
  /** A50 (P2): Ollama's /api/chat response carries no token-usage fields at
   * all (unlike the HTTP BYOK adapters), so this rung silently zeroed out
   * cost accounting in report.model_trace. Estimated from character counts —
   * see estimateUsage's doc comment for why that's flagged, not exact. */
  lastUsage?: AdapterUsage;

  constructor(opts: OllamaOptions = {}) {
    this.model = opts.model ?? 'llama3.2-vision';
    this.baseUrl = (opts.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.name = `ollama(${this.model})`;
  }

  /** Cached availability: the router calls available() on every adapter for EVERY
   * plan-step and visual-verdict, and Ollama is always in the ladder, so an
   * uncached 300ms probe-per-step is pure waste when nothing's listening (the
   * common case). Cache the result (hit OR miss) for a short window. */
  private availableCache: { value: boolean; at: number } | null = null;
  private static readonly AVAIL_TTL_MS = 30_000;

  /** Fast probe: GET /api/tags with a 300ms timeout → true on 200. Nothing
   * listening (the common case on a dev box) fails fast, no error to the caller. */
  async available(): Promise<boolean> {
    const cached = this.availableCache;
    if (cached && Date.now() - cached.at < OllamaAdapter.AVAIL_TTL_MS) return cached.value;
    let value = false;
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(300) });
      value = res.ok;
    } catch {
      value = false;
    }
    this.availableCache = { value, at: Date.now() };
    return value;
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
      // A50 (P2): "api status" is deliberate — model-router.ts's
      // STATUS_IN_MESSAGE_RE now requires an HTTP-context word near the 3
      // digits before it will classify them as a status code at all (see its
      // doc comment); this keeps Ollama's 429/503 transient-retry detection
      // working under that stricter regex.
      throw new Error(`ollama api status ${res.status}: ${(await res.text()).slice(0, 400)}`);
    }
    const body = (await res.json()) as { message?: { content?: string } };
    const content = body.message?.content ?? '';
    // A50 (P2): the router reads adapter.lastUsage immediately after THIS
    // call resolves, so it must be set before returning.
    this.lastUsage = estimateUsage(req.prompt.length, content.length);
    return extractJson(content);
  }
}
