/* V56 — A25: honor the HTTP `Retry-After` response header on 429/503.
 *
 * docs/plan/26-08-27-audit-market-readiness.md A25: openai-compatible.ts,
 * anthropic.ts, byok-gemini.ts all discarded the server's `Retry-After`
 * guidance on rate-limit/overload responses and fell back to blind
 * exponential backoff — even though model-router.ts's classifyFailure()
 * already has a typed-hint path (a `.retryAfterMs` property on the thrown
 * error, checked BEFORE any text-sniffing) that Gemini's body-embedded
 * `retryDelay` field rides today via text extraction. The fix attaches that
 * same typed `.retryAfterMs` property, parsed from the `Retry-After` header,
 * to the error each adapter throws on a non-ok 429/503 response.
 *
 * This suite stubs global.fetch to return a 429 with a Retry-After header —
 * both the numeric-seconds form ("120") and the HTTP-date form
 * ("Wed, 21 Oct 2026 07:28:00 GMT") — and asserts:
 *  - the adapter's generateJson() rejection carries a typed retryAfterMs
 *    matching the header (not left for classifyFailure's text-sniffing)
 *  - classifyFailure() on that error reports transient:true with the exact
 *    hinted delay, i.e. the SAME priority-1 typed-hint path model-router.ts
 *    already uses for a future typed RateLimitError / Gemini's retryDelay
 *  - a 503 also carries the hint (not just 429)
 *  - a non-transient status (401) or a response with no Retry-After header
 *    does NOT get a retryAfterMs hint fabricated
 *
 * No real network calls: fetch is stubbed per-test and restored after.
 *
 * Run: npx tsx test/v56.retry-after-header.ts
 */

import { classifyFailure } from '../src/router/model-router.js';
import { AnthropicAdapter } from '../src/router/adapters/anthropic.js';
import { OpenAiCompatibleAdapter } from '../src/router/adapters/openai-compatible.js';
import { ByokGeminiAdapter } from '../src/router/adapters/byok-gemini.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const originalFetch = globalThis.fetch;

/** Minimal fetch stub: always returns a non-ok response with the given
 * status + retry-after header value (or none), regardless of the request. */
function stubFetch(status: number, retryAfterHeader: string | undefined, bodyText = '{"error":"rate limited"}') {
  globalThis.fetch = (async () => {
    return {
      ok: false,
      status,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'retry-after' ? (retryAfterHeader ?? null) : null),
      },
      text: async () => bodyText,
      json: async () => JSON.parse(bodyText),
    } as unknown as Response;
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

async function expectThrow(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    throw new Error('expected fn() to throw');
  } catch (e) {
    return e;
  }
}

/* ===================== anthropic.ts ===================== */

{
  stubFetch(429, '120'); // numeric seconds
  const adapter = new AnthropicAdapter({ apiKey: 'k', model: 'claude-haiku-4-5' });
  const err = (await expectThrow(() => adapter.generateJson({ prompt: 'p', schema: {} }))) as Error & {
    retryAfterMs?: number;
  };
  check('anthropic 429 + numeric Retry-After: typed retryAfterMs = 120000', err.retryAfterMs === 120_000);
  const c = classifyFailure(err);
  check('anthropic: classifyFailure reports transient + exact hinted delay', c.transient === true && c.retryAfterMs === 120_000);
  restoreFetch();
}

{
  const future = new Date(Date.now() + 60_000);
  stubFetch(503, future.toUTCString()); // HTTP-date form
  const adapter = new AnthropicAdapter({ apiKey: 'k', model: 'claude-haiku-4-5' });
  const err = (await expectThrow(() => adapter.generateJson({ prompt: 'p', schema: {} }))) as Error & {
    retryAfterMs?: number;
  };
  check(
    'anthropic 503 + HTTP-date Retry-After: retryAfterMs close to 60s',
    typeof err.retryAfterMs === 'number' && Math.abs(err.retryAfterMs - 60_000) < 2000,
  );
  restoreFetch();
}

{
  // 401 must never get a fabricated retry hint.
  stubFetch(401, '30');
  const adapter = new AnthropicAdapter({ apiKey: 'k', model: 'claude-haiku-4-5' });
  const err = (await expectThrow(() => adapter.generateJson({ prompt: 'p', schema: {} }))) as Error & {
    retryAfterMs?: number;
  };
  check('anthropic 401 (non-transient status): no retryAfterMs attached', err.retryAfterMs === undefined);
  restoreFetch();
}

{
  // 429 with no header at all must not fabricate a hint either.
  stubFetch(429, undefined);
  const adapter = new AnthropicAdapter({ apiKey: 'k', model: 'claude-haiku-4-5' });
  const err = (await expectThrow(() => adapter.generateJson({ prompt: 'p', schema: {} }))) as Error & {
    retryAfterMs?: number;
  };
  check('anthropic 429 without a Retry-After header: no retryAfterMs attached', err.retryAfterMs === undefined);
  restoreFetch();
}

/* ===================== openai-compatible.ts ===================== */

{
  stubFetch(429, '5');
  const adapter = new OpenAiCompatibleAdapter({
    apiKey: 'k',
    model: 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1',
    label: 'gpt',
  });
  const err = (await expectThrow(() => adapter.generateJson({ prompt: 'p', schema: {} }))) as Error & {
    retryAfterMs?: number;
  };
  check('openai-compatible 429 + numeric Retry-After: retryAfterMs = 5000', err.retryAfterMs === 5000);
  const c = classifyFailure(err);
  check('openai-compatible: classifyFailure honours the hint', c.transient === true && c.retryAfterMs === 5000);
  restoreFetch();
}

{
  const future = new Date(Date.now() + 15_000);
  stubFetch(503, future.toUTCString());
  const adapter = new OpenAiCompatibleAdapter({
    apiKey: 'k',
    model: 'glm-5.2',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    label: 'glm',
  });
  const err = (await expectThrow(() => adapter.generateJson({ prompt: 'p', schema: {} }))) as Error & {
    retryAfterMs?: number;
  };
  check(
    'openai-compatible 503 + HTTP-date Retry-After: retryAfterMs close to 15s',
    typeof err.retryAfterMs === 'number' && Math.abs(err.retryAfterMs - 15_000) < 2000,
  );
  restoreFetch();
}

/* ===================== byok-gemini.ts ===================== */

{
  stubFetch(429, '31', '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}');
  const adapter = new ByokGeminiAdapter({ apiKey: 'k', model: 'gemini-2.0-flash' });
  const err = (await expectThrow(() => adapter.generateJson({ prompt: 'p', schema: {} }))) as Error & {
    retryAfterMs?: number;
  };
  check('byok-gemini 429 + numeric Retry-After header: retryAfterMs = 31000', err.retryAfterMs === 31_000);
  const c = classifyFailure(err);
  check('byok-gemini: classifyFailure honours the header hint', c.transient === true && c.retryAfterMs === 31_000);
  restoreFetch();
}

{
  const future = new Date(Date.now() + 10_000);
  stubFetch(503, future.toUTCString());
  const adapter = new ByokGeminiAdapter({ apiKey: 'k', model: 'gemini-2.0-flash' });
  const err = (await expectThrow(() => adapter.generateJson({ prompt: 'p', schema: {} }))) as Error & {
    retryAfterMs?: number;
  };
  check(
    'byok-gemini 503 + HTTP-date Retry-After: retryAfterMs close to 10s',
    typeof err.retryAfterMs === 'number' && Math.abs(err.retryAfterMs - 10_000) < 2000,
  );
  restoreFetch();
}

{
  // Header form wins even when the body ALSO carries Gemini's own text-sniffed
  // retryDelay — the typed header-derived hint should be what's attached, and
  // classifyFailure's priority-1 typed check picks it up directly (never falls
  // through to its own text-sniffing of the body for this error).
  stubFetch(
    429,
    '7',
    '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"90s"}]}}',
  );
  const adapter = new ByokGeminiAdapter({ apiKey: 'k', model: 'gemini-2.0-flash' });
  const err = (await expectThrow(() => adapter.generateJson({ prompt: 'p', schema: {} }))) as Error & {
    retryAfterMs?: number;
  };
  check('byok-gemini: header-derived hint (7s) wins over body text (90s)', err.retryAfterMs === 7000);
  const c = classifyFailure(err);
  check('classifyFailure resolves to the header value, not the body text', c.retryAfterMs === 7000);
  restoreFetch();
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
