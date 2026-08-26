/* v62 — A50 (P2): router bookkeeping gaps.
 *  1. lastUsage: CLI/Ollama adapters never populated it, so their cost was
 *     silently zero in report.model_trace. Both now estimate token counts
 *     from prompt/response character counts ÷ 4, flagged `estimated: true`.
 *  2. STATUS_IN_MESSAGE_RE (model-router.ts) is anchored to require an
 *     HTTP-context word near the 3 digits, so it no longer misparses an
 *     unrelated 3-digit number in CLI stderr (e.g. a stack trace's
 *     `file.js:429:12`) as an HTTP status.
 *  3. Schema/JSON-parse failures get ONE same-rung retry before the router
 *     escalates to the next rung.
 *
 * No real network calls (fetch is stubbed) and no real CLI binary is spawned
 * (a throwaway shell script shadows `claude` on PATH, POSIX only — skipped
 * on win32, matching v54's own precedent for platform-specific process
 * mechanics).
 *
 *  Run: npx tsx test/v62.router-bookkeeping.ts   (exits nonzero on any failed check)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estimateUsage as ollamaEstimateUsage, OllamaAdapter } from '../src/router/adapters/ollama.js';
import { estimateUsage as cliEstimateUsage, CliPlannerAdapter } from '../src/router/adapters/cli-planner.js';
import { classifyFailure, ModelRouter } from '../src/router/model-router.js';
import type { Capability, JsonRequest, ModelAdapter } from '../src/router/adapter.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

console.log('=== v62: A50 router bookkeeping ===');

/* ---------- 1a. estimateUsage pure math (both adapters share the ÷4 recipe) ---------- */
{
  const u = ollamaEstimateUsage(400, 40);
  check('ollama estimateUsage: promptTokens = ceil(chars/4)', u.promptTokens === 100);
  check('ollama estimateUsage: outputTokens = ceil(chars/4)', u.outputTokens === 10);
  check('ollama estimateUsage: totalTokens sums both', u.totalTokens === 110);
  check('ollama estimateUsage: flagged estimated:true', u.estimated === true);
}
{
  const u = cliEstimateUsage(401, 39);
  check('cli-planner estimateUsage: rounds UP (ceil), not down', u.promptTokens === 101 && u.outputTokens === 10);
  check('cli-planner estimateUsage: flagged estimated:true', u.estimated === true);
}

/* ---------- 1b. OllamaAdapter.lastUsage populated after a real call (fetch stubbed) ---------- */
{
  const originalFetch = globalThis.fetch;
  const prompt = 'x'.repeat(200);
  globalThis.fetch = (async (url: string) => {
    if (String(url).endsWith('/api/tags')) return { ok: true } as Response; // available() probe
    return {
      ok: true,
      status: 200,
      json: async () => ({ message: { content: '{"verdict":"pass","summary":"ok","issues":[]}' } }),
    } as unknown as Response;
  }) as typeof fetch;
  try {
    const adapter = new OllamaAdapter({});
    check('ollama: lastUsage is undefined before any call', adapter.lastUsage === undefined);
    await adapter.generateJson({ prompt, schema: { type: 'object' } });
    check('ollama: lastUsage populated after generateJson()', adapter.lastUsage !== undefined);
    check('ollama: lastUsage.estimated === true', adapter.lastUsage?.estimated === true);
    check('ollama: lastUsage.promptTokens tracks the prompt length', adapter.lastUsage?.promptTokens === Math.ceil(prompt.length / 4));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/* ---------- 1c. CliPlannerAdapter.lastUsage populated after a real call (fake `claude` on PATH) ---------- */
if (process.platform === 'win32') {
  console.log('SKIP  cli-planner lastUsage integration (PATH-shadowed POSIX shell script, not win32-portable)');
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-fakeclaude-'));
  const scriptPath = path.join(dir, 'claude');
  const envelope = JSON.stringify({
    result: JSON.stringify({ thought: 'x', actions: [{ type: 'finish', verdict: 'pass', reason: 'done' }] }),
  });
  fs.writeFileSync(scriptPath, `#!/bin/sh\ncat <<'EOF'\n${envelope}\nEOF\n`);
  fs.chmodSync(scriptPath, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath}`;
  try {
    const adapter = new CliPlannerAdapter({ bin: 'claude', model: undefined });
    check('cli-planner: lastUsage is undefined before any call', adapter.lastUsage === undefined);
    const out = await adapter.generateJson({ prompt: 'plan the next step', schema: { type: 'object' } });
    check('cli-planner: the fake claude script\'s envelope was correctly unwrapped', (out as { thought?: string }).thought === 'x');
    check('cli-planner: lastUsage populated after generateJson()', adapter.lastUsage !== undefined);
    check('cli-planner: lastUsage.estimated === true', adapter.lastUsage?.estimated === true);
  } finally {
    process.env.PATH = originalPath;
  }
}

/* ---------- 2. STATUS_IN_MESSAGE_RE anchoring ---------- */
{
  const stackTrace = classifyFailure(new Error('claude exit 1: at file.js:429:12 unexpected token'));
  check('an unrelated 3-digit:colon in CLI stderr is NOT an HTTP status', stackTrace.transient === false);

  const realHttp = classifyFailure(new Error('gemini api 429: {"error":{"message":"quota exceeded"}}'));
  check('a real "<label> api <status>:" message still classifies as transient', realHttp.transient === true);

  const ollamaHttp = classifyFailure(new Error('ollama api status 503: overloaded'));
  check('ollama\'s real (post-A50) status message still classifies as transient', ollamaHttp.transient === true);

  const bareStatusWord = classifyFailure(new Error('request failed, http status 502: gateway error'));
  check('a message using "status"/"http" context words also matches', bareStatusWord.transient === true);
}

/* ---------- 3. same-rung retry on schema/parse failure ---------- */
function fake(name: string, rung: 0 | 1 | 2 | 3, impl: () => unknown): ModelAdapter & { calls: number } {
  const adapter = {
    name,
    rung,
    calls: 0,
    available: async () => true,
    supports: (_c: Capability) => true,
    generateJson: async (_req: JsonRequest) => {
      adapter.calls++;
      return impl();
    },
  };
  return adapter;
}

{
  // First call throws a schema/parse error, second call (same adapter) succeeds.
  let attempt = 0;
  const primary = fake('primary', 1, () => {
    attempt++;
    if (attempt === 1) throw new Error('model output contained no parseable JSON: not json at all');
    return { thought: 'ok', actions: [{ type: 'finish', verdict: 'pass', reason: 'done' }] };
  });
  const fallback = fake('fallback', 2, () => ({ thought: 'never', actions: [{ type: 'finish', verdict: 'pass', reason: 'never' }] }));
  // preferFreePlanner: true keeps ascending-rung ordering — without it the
  // router's own BYOK-fast path promotes the rung-2 fallback AHEAD of the
  // rung-1 primary for plan-step, which would call the wrong adapter first
  // and defeat the point of this fixture (mirrors v40.rate-limit.ts's own
  // ROUTER_OPTS comment for the identical reason).
  const router = new ModelRouter([primary, fallback], {
    preferFreePlanner: true,
    retryPolicy: { maxAttempts: 1, baseDelaysMs: [1], maxTotalDelayMs: 10 },
  });
  const result = await router.planJson('plan', {}, 1);
  check('schema-retry: succeeded via the SAME adapter (primary), not escalated', primary.calls === 2 && fallback.calls === 0);
  check('schema-retry: router resolved with the retried result', (result as { thought?: string }).thought === 'ok');
  check(
    'schema-retry: trace records the retry note before the success entry',
    router.trace.some((t) => t.note?.includes('schema/parse error → same-rung retry')),
  );
}

{
  // Schema/parse error on BOTH attempts against the primary → escalates to the next rung.
  const alwaysBadJson = fake('always-bad', 1, () => {
    throw new Error('model output contained no parseable JSON: still not json');
  });
  const fallback2 = fake('fallback2', 2, () => ({ thought: 'rescued', actions: [{ type: 'finish', verdict: 'pass', reason: 'done' }] }));
  const router2 = new ModelRouter([alwaysBadJson, fallback2], {
    preferFreePlanner: true,
    retryPolicy: { maxAttempts: 1, baseDelaysMs: [1], maxTotalDelayMs: 10 },
  });
  const result2 = await router2.planJson('plan', {}, 1);
  check(
    'schema-retry: exactly ONE same-rung retry, then escalates (not infinite, not zero)',
    alwaysBadJson.calls === 2 && fallback2.calls === 1,
  );
  check('schema-retry: escalation reaches the fallback adapter\'s result', (result2 as { thought?: string }).thought === 'rescued');
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v62 checks passed`);
process.exit(failed.length ? 1 : 0);
