/* V40 — retry-with-backoff for transient adapter failures (A20).
 *
 * docs/plan/26-08-08-audit-deterministic-speed.md A20: planWith()/visualVerdict()
 * used to catch ANY adapter failure and immediately fall to the next rung — no
 * retry, no backoff, no special-casing of HTTP 429. Under a parallel suite
 * runner a burst of 429s would silently demote every worker to a weaker model.
 *
 * This suite exercises classifyFailure() directly (pure function, no timers)
 * and the retry loop wired into ModelRouter.planJson()/visualVerdict() via fake
 * in-memory ModelAdapter stubs — no network calls, no real providers. All
 * router-level cases use a tiny injected retryPolicy (ModelRouterOptions.retryPolicy)
 * so the suite runs in well under a second instead of waiting out the real
 * ~250ms/~750ms/~2s production backoff.
 *
 * Covers:
 *  - classifyFailure: 429/502/503/504 transient, other 4xx/5xx and schema
 *    errors not transient, network-error messages transient, Retry-After /
 *    Gemini retryDelay text honoured
 *  - router: 429 then success retries the SAME adapter (no rung fall-through)
 *  - router: 401 falls through immediately with zero retries
 *  - router: an always-429 adapter eventually gives up and falls through
 *    (bounded retries), not looping forever
 *  - router: total added latency stays under the configured cap
 *  - router: an explicit Retry-After-style hint is honoured (short-circuits
 *    the exponential backoff schedule)
 *  - router: the trace records attempts/retried
 *  - router: a schema/validation error is not retried
 *
 * Run: npx tsx test/v40.rate-limit.ts
 */

import {
  classifyFailure,
  ModelRouter,
  type RetryPolicy,
} from '../src/router/model-router.js';
import type { Capability, JsonRequest, ModelAdapter } from '../src/router/adapter.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

function fake(
  name: string,
  rung: 0 | 1 | 2 | 3,
  caps: Capability[],
  impl: (req: JsonRequest, call: number) => unknown,
): ModelAdapter & { calls: number } {
  const adapter = {
    name,
    rung,
    calls: 0,
    available: async () => true,
    supports: (c: Capability) => caps.includes(c),
    generateJson: async (req: JsonRequest) => {
      adapter.calls++;
      return impl(req, adapter.calls);
    },
  };
  return adapter;
}

// A retry policy fast enough that the whole suite runs in well under a second,
// while still exercising the real exponential-schedule shape (increasing
// delays, a hard total cap).
const FAST_POLICY: Partial<RetryPolicy> = {
  maxAttempts: 3,
  baseDelaysMs: [5, 15],
  maxTotalDelayMs: 100,
};

// Tests below mix a rung-1 "primary" adapter with a rung-2 "backup" to exercise
// fall-through. ModelRouter has its OWN unrelated reordering for plan-step/
// plan-goals — a live rung-2 BYOK adapter is promoted ahead of rung 1 unless
// preferFreePlanner is set (model-router.ts's planRank fast path) — which would
// otherwise call the rung-2 "backup" FIRST and never exercise the rung-1
// adapter's retry behaviour at all. preferFreePlanner:true opts back into plain
// ascending rung order so these fixtures test what they say they test.
const ROUTER_OPTS = { retryPolicy: FAST_POLICY, preferFreePlanner: true } as const;

const png = Buffer.from('fakepng');

/* ===================== classifyFailure (pure) ===================== */

{
  const c = classifyFailure(new Error('gemini api 429: {"error":{"message":"quota exceeded"}}'));
  check('429 is transient', c.transient === true);
}

{
  const c = classifyFailure(new Error('anthropic api 503: upstream overloaded'));
  check('503 is transient', c.transient === true);
}
{
  // A50 (P2): STATUS_IN_MESSAGE_RE now requires an HTTP-context word near the
  // 3 digits — this mirrors ollama.ts's real (post-A50) error text, "ollama
  // api status <n>: <body>".
  const c = classifyFailure(new Error('ollama api status 502: bad gateway'));
  check('502 is transient', c.transient === true);
}
{
  // A50 (P2): the exact bug this finding calls out — a bare 3-digit number
  // followed by a colon with NO HTTP context (e.g. CLI stderr noise like a
  // `file.js:429:12` stack-trace line:column) must NOT be misparsed as an
  // HTTP status.
  const c = classifyFailure(new Error('claude exit 1: at file.js:429:12 unexpected token'));
  check('an unrelated 3-digit:colon in CLI stderr is NOT treated as an HTTP status', c.transient === false);
}
{
  const c = classifyFailure(new Error('gpt api 504: gateway timeout'));
  check('504 is transient', c.transient === true);
}

{
  const c = classifyFailure(new Error('gemini api 401: unauthorized'));
  check('401 is NOT transient (bad key fails fast)', c.transient === false);
}
{
  const c = classifyFailure(new Error('gpt api 400: invalid request'));
  check('400 is NOT transient', c.transient === false);
}
{
  const c = classifyFailure(new Error('anthropic api 500: internal error'));
  check('bare 500 is NOT transient (not in the 429/502-504 allowlist)', c.transient === false);
}

{
  const c = classifyFailure(
    new Error('model output contained no parseable JSON: {"oops": true'),
  );
  check('schema/JSON-parse error is NOT transient', c.transient === false);
}
{
  const c = classifyFailure(new Error('byok-gemini: no API key configured'));
  check('missing-key error is NOT transient', c.transient === false);
}

{
  const c = classifyFailure(new Error('fetch failed: ECONNRESET'));
  check('ECONNRESET is transient', c.transient === true);
}
{
  const c = classifyFailure(new Error('request to https://x failed, reason: socket hang up'));
  check('socket hang up is transient', c.transient === true);
}

{
  // Gemini's real 429 body shape: a RetryInfo detail with a retryDelay field.
  const c = classifyFailure(
    new Error(
      'gemini api 429: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"3s"}]}}',
    ),
  );
  check('429 + retryDelay text is transient', c.transient === true);
  check('retryDelay "3s" parsed as 3000ms', c.retryAfterMs === 3000);
}

{
  // Typed hint takes precedence over any message parsing.
  const err = Object.assign(new Error('rate limited'), { retryAfterMs: 42 });
  const c = classifyFailure(err);
  check('typed retryAfterMs hint honoured', c.transient === true && c.retryAfterMs === 42);
}

{
  const err = Object.assign(new Error('rate limited'), { status: 429, retryAfter: 2 });
  const c = classifyFailure(err);
  check('typed retryAfter (seconds) honoured', c.transient === true && c.retryAfterMs === 2000);
}

/* ===================== router: planJson / visualVerdict ===================== */

{
  // 429 then success — same adapter retried, no fall-through to a next rung.
  const adapter = fake('flaky', 1, ['plan-step'], (_req, call) => {
    if (call === 1) throw new Error('gemini api 429: rate limited');
    return { action: 'click' };
  });
  const router = new ModelRouter([adapter], { retryPolicy: FAST_POLICY });
  const result = (await router.planJson('do it', {}, 1)) as { action: string };
  check('429-then-success returns the eventual result', result.action === 'click');
  check('the SAME adapter served the call (2 attempts)', adapter.calls === 2);
  check('exactly one trace entry (no rung fall-through)', router.trace.length === 1);
  check('trace records attempts=2 / retried=true', router.trace[0].attempts === 2 && router.trace[0].retried === true);
}

{
  // 401 falls through immediately, zero retries against the failing adapter.
  const bad = fake('bad-key', 1, ['plan-step'], () => {
    throw new Error('gemini api 401: unauthorized');
  });
  const good = fake('backup', 2, ['plan-step'], () => ({ action: 'ok' }));
  const router = new ModelRouter([bad, good], ROUTER_OPTS);
  const result = (await router.planJson('do it', {}, 1)) as { action: string };
  check('falls through to the next rung on 401', result.action === 'ok');
  check('the failing adapter was called exactly once (no retry)', bad.calls === 1);
  check('failed-adapter trace entry has no attempts field (single try)', router.trace[0].attempts === undefined);
}

{
  // Always-429 adapter: bounded retries, then falls through — never loops forever.
  const alwaysRateLimited = fake('always-429', 1, ['plan-step'], () => {
    throw new Error('gemini api 429: still limited');
  });
  const backup = fake('backup2', 2, ['plan-step'], () => ({ action: 'fallback' }));
  const router = new ModelRouter([alwaysRateLimited, backup], ROUTER_OPTS);
  const t0 = Date.now();
  const result = (await router.planJson('do it', {}, 1)) as { action: string };
  const elapsed = Date.now() - t0;
  check('eventually falls through to the backup rung', result.action === 'fallback');
  check(
    'retries are bounded (maxAttempts=3, not infinite)',
    alwaysRateLimited.calls === 3,
  );
  check('total backoff stayed well under the cap (elapsed < 500ms)', elapsed < 500);
}

{
  // Retry-After-style hint short-circuits the exponential schedule and is honoured.
  const adapter = fake('respects-retry-after', 1, ['plan-step'], (_req, call) => {
    if (call === 1) {
      throw new Error(
        'gemini api 429: {"error":{"details":[{"retryDelay":"0.01s"}]}}',
      );
    }
    return { action: 'click' };
  });
  const router = new ModelRouter([adapter], { retryPolicy: FAST_POLICY });
  const t0 = Date.now();
  await router.planJson('do it', {}, 1);
  const elapsed = Date.now() - t0;
  check('Retry-After hint honoured (still succeeds on the same adapter)', adapter.calls === 2);
  check('a tiny retryDelay hint keeps latency small', elapsed < 200);
}

{
  // Hard cap: even with a huge Retry-After hint, added latency never exceeds
  // maxTotalDelayMs by more than the last granted slice.
  const adapter = fake('huge-retry-after', 1, ['plan-step'], (_req, call) => {
    if (call < 3) throw new Error('gemini api 429: {"error":{"details":[{"retryDelay":"30s"}]}}');
    return { action: 'click' };
  });
  const backup = fake('backup3', 2, ['plan-step'], () => ({ action: 'fallback' }));
  const router = new ModelRouter([adapter, backup], ROUTER_OPTS);
  const t0 = Date.now();
  const result = (await router.planJson('do it', {}, 1)) as { action: string };
  const elapsed = Date.now() - t0;
  check('a huge Retry-After hint is capped, run does not hang', elapsed < 300);
  check('falls through to backup once the backoff budget is exhausted', result.action === 'fallback');
}

{
  // A50 (P2): schema/validation error — the router now retries the SAME rung
  // ONCE (a one-off "model didn't emit valid JSON that time" hiccup often
  // just works on a bare retry) before falling through — see
  // v62.router-bookkeeping.ts for the dedicated same-rung-retry coverage.
  // Two consecutive failures still falls through, same as before.
  const badJson = fake('bad-json', 1, ['plan-step'], () => {
    throw new Error('model output contained no parseable JSON: not json at all');
  });
  const good = fake('backup4', 2, ['plan-step'], () => ({ action: 'ok' }));
  const router = new ModelRouter([badJson, good], ROUTER_OPTS);
  const result = (await router.planJson('do it', {}, 1)) as { action: string };
  check('schema error (twice) falls through to next rung', result.action === 'ok');
  check('schema error gets exactly one same-rung retry before escalating (A50)', badJson.calls === 2);
}

{
  // Same behaviour on the visual-verdict path (visualVerdict, not just planJson).
  const flakyVisual = fake('flaky-visual', 1, ['visual-verdict'], (_req, call) => {
    if (call === 1) throw new Error('anthropic api 503: overloaded');
    return { verdict: 'pass', summary: 'ok', issues: [] };
  });
  const router = new ModelRouter([flakyVisual], { retryPolicy: FAST_POLICY });
  const v = await router.visualVerdict(png, 'page ok?', 1);
  check('visualVerdict retries a 503 on the same adapter', v.verdict === 'pass' && flakyVisual.calls === 2);
  check('visualVerdict trace records the retry', router.trace[0].attempts === 2 && router.trace[0].retried === true);
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
