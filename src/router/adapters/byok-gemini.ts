/* Rung 2 — BYOK: direct Gemini API with the user's key. The adapter shape is
 * the seam: an OpenRouter/OpenAI adapter drops in by implementing ModelAdapter
 * the same way. Unavailable (cleanly) when no key is configured.
 *
 * Also the natural first video-verdict route (Phase 8, opt-in via
 * cfg.videoAssertions): the Gemini Files API accepts an uploaded video clip as
 * a `fileData` part in generateContent, so a recorded WebM/MP4 gets the same
 * schema-enforced verdict a screenshot does. Anthropic/OpenAI stay
 * screenshot-only — neither has a viable BYOK video-upload-and-judge path
 * today, so they simply never set supportsVideo/videoVerdict. */

import fs from 'node:fs';
import path from 'node:path';
import type { AdapterUsage, Capability, JsonRequest, ModelAdapter } from '../adapter.js';
import { extractJson, withSchemaInstruction } from '../adapter.js';
import { VERDICT_JSON_SCHEMA, videoVerdictPrompt } from '../verdict.js';

export interface ByokGeminiOptions {
  apiKey?: string;
  model: string;
  timeoutMs?: number;
}

/** Gemini Files API upload response (subset used here). */
interface GeminiFile {
  name?: string;
  uri?: string;
  mimeType?: string;
  state?: 'PROCESSING' | 'ACTIVE' | 'FAILED';
}

/** video/gif extension → MIME type. Covers the clip formats the recorder
 * backends (CDP screencast GIF, extension tabCapture WebM) actually produce. */
function mimeTypeForClip(clipPath: string): string {
  switch (path.extname(clipPath).toLowerCase()) {
    case '.webm': return 'video/webm';
    case '.mp4': return 'video/mp4';
    case '.gif': return 'image/gif';
    default: return 'application/octet-stream';
  }
}

export class ByokGeminiAdapter implements ModelAdapter {
  readonly name: string;
  readonly rung = 2 as const;
  readonly supportsVideo = true;
  lastUsage?: AdapterUsage;

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
    this.lastUsage = undefined; // reset; set only when usageMetadata comes back
    // Steer the shape IN-PROMPT (+ responseMimeType:'application/json' to force
    // valid JSON) and parse with extractJson — the same recipe the other adapters
    // use. Do NOT pass req.schema as Gemini's `responseSchema`: our schemas use
    // constructs (additionalProperties, minItems, $-keywords) that Gemini's strict
    // schema subset rejects with a 400 "Unknown name" error.
    const parts: object[] = [{ text: withSchemaInstruction(req.prompt, req.schema) }];
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
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
        cachedContentTokenCount?: number;
      };
    };
    const um = body.usageMetadata;
    if (um) {
      const usage: AdapterUsage = {};
      if (typeof um.promptTokenCount === 'number') usage.promptTokens = um.promptTokenCount;
      if (typeof um.candidatesTokenCount === 'number') usage.outputTokens = um.candidatesTokenCount;
      if (typeof um.totalTokenCount === 'number') usage.totalTokens = um.totalTokenCount;
      if (typeof um.cachedContentTokenCount === 'number') usage.cachedTokens = um.cachedContentTokenCount;
      if (Object.keys(usage).length) this.lastUsage = usage;
    }
    const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    return extractJson(text);
  }

  /** Upload the clip to the Gemini Files API, wait for it to leave PROCESSING,
   * then ask for a schema-enforced verdict referencing the uploaded file.
   * Returns the raw parsed JSON (ModelRouter.videoVerdict() normalizes it into
   * NanoVerdict, same as generateJson() does for a screenshot verdict). */
  async videoVerdict(clipPath: string, expectation: string): Promise<unknown> {
    if (!this.opts.apiKey) throw new Error('byok-gemini: no API key configured');
    const mimeType = mimeTypeForClip(clipPath);
    const uploaded = await this.uploadFile(clipPath, mimeType);
    const file = await this.waitUntilActive(uploaded);
    this.lastUsage = undefined; // reset; set only when usageMetadata comes back
    const prompt = withSchemaInstruction(videoVerdictPrompt(expectation), VERDICT_JSON_SCHEMA);
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.opts.model}:generateContent`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.opts.apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ fileData: { fileUri: file.uri, mimeType: file.mimeType ?? mimeType } }, { text: prompt }],
            },
          ],
          generationConfig: { responseMimeType: 'application/json' },
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
      },
    );
    if (!res.ok) {
      throw new Error(`gemini api (video) ${res.status}: ${(await res.text()).slice(0, 400)}`);
    }
    const body = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
        cachedContentTokenCount?: number;
      };
    };
    const um = body.usageMetadata;
    if (um) {
      const usage: AdapterUsage = {};
      if (typeof um.promptTokenCount === 'number') usage.promptTokens = um.promptTokenCount;
      if (typeof um.candidatesTokenCount === 'number') usage.outputTokens = um.candidatesTokenCount;
      if (typeof um.totalTokenCount === 'number') usage.totalTokens = um.totalTokenCount;
      if (typeof um.cachedContentTokenCount === 'number') usage.cachedTokens = um.cachedContentTokenCount;
      if (Object.keys(usage).length) this.lastUsage = usage;
    }
    const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    return extractJson(text);
  }

  /** Multipart upload to the Files API (`X-Goog-Upload-Protocol: multipart`) —
   * a single request, no resumable-upload session needed for clip-sized files. */
  private async uploadFile(clipPath: string, mimeType: string): Promise<GeminiFile> {
    const data = fs.readFileSync(clipPath);
    const boundary = `qa-video-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const metadata = JSON.stringify({ file: { display_name: path.basename(clipPath) } });
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const res = await fetch(
      `https://generativelanguage.googleapis.com/upload/v1beta/files`,
      {
        method: 'POST',
        headers: {
          'X-Goog-Upload-Protocol': 'multipart',
          'Content-Type': `multipart/related; boundary=${boundary}`,
          'x-goog-api-key': this.opts.apiKey!,
        },
        body,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
      },
    );
    if (!res.ok) {
      throw new Error(`gemini files upload ${res.status}: ${(await res.text()).slice(0, 400)}`);
    }
    const json = (await res.json()) as { file?: GeminiFile };
    if (!json.file?.uri || !json.file.name) {
      throw new Error('gemini files upload: response had no file uri/name');
    }
    return json.file;
  }

  /** Poll GET /v1beta/{name} until the upload leaves PROCESSING. Video files
   * are not immediately queryable by generateContent — small clips are
   * typically ACTIVE within a few seconds. Bounded to ~30s so a stuck upload
   * fails fast rather than hanging the driver step. */
  private async waitUntilActive(file: GeminiFile): Promise<GeminiFile> {
    let current = file;
    const deadline = Date.now() + 30_000;
    while (current.state === 'PROCESSING' && Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 2_000));
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${current.name}`,
        {
          headers: { 'x-goog-api-key': this.opts.apiKey! },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!res.ok) break; // best effort — fall through and let generateContent surface the real error
      current = (await res.json()) as GeminiFile;
    }
    if (current.state === 'FAILED') {
      throw new Error('gemini files upload: file processing failed');
    }
    return current;
  }
}
