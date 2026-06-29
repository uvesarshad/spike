/* V25 — custom-AI provider selection. Offline + deterministic (no Chrome, no
 * network, no model quota):
 *  Part 1: ModelRouter pins the chosen "browsing control AI" to the front of the
 *          planner ladder, keeps Nano first for visuals, and falls back when the
 *          pin is unavailable.
 *  Part 2: the Anthropic + OpenAI-compatible adapters build the right HTTP request
 *          (mocked fetch) and parse a verdict/plan reply. */

import type { Capability, JsonRequest, ModelAdapter } from '../src/router/adapter.js';
import { ModelRouter } from '../src/router/model-router.js';
import { AnthropicAdapter } from '../src/router/adapters/anthropic.js';
import { OpenAiCompatibleAdapter } from '../src/router/adapters/openai-compatible.js';
import { CliPlannerAdapter } from '../src/router/adapters/cli-planner.js';
import { isSafeModelId } from '../src/vibe/settings.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

function fake(
  name: string,
  rung: 0 | 1 | 2 | 3,
  caps: Capability[],
  impl: (req: JsonRequest) => unknown,
  isAvailable = true,
): ModelAdapter {
  return {
    name,
    rung,
    available: async () => isAvailable,
    supports: (c) => caps.includes(c),
    generateJson: async (req) => impl(req),
  };
}

const png = Buffer.from('fakepng');
const okPlan = { thought: 'x', actions: [{ type: 'finish', verdict: 'pass', reason: 'done' }] };

/* ---------- part 1: pinning + fallback ---------- */

{
  // pinned adapter leads the planner ladder even though a lower rung exists
  const router = new ModelRouter(
    [
      fake('google-cli', 1, ['plan-step', 'visual-verdict'], () => okPlan),
      fake('anthropic(claude-haiku-4-5)', 2, ['plan-step', 'visual-verdict'], () => okPlan),
    ],
    { pinnedAdapter: 'anthropic(claude-haiku-4-5)' },
  );
  await router.planJson('plan!', {}, 1);
  check('pinned rung-2 leads plan-step (over rung-1)', router.trace[0].adapter === 'anthropic(claude-haiku-4-5)');
}

{
  // visual ladder keeps Nano (rung 0) first, pinned slots in right after it
  const router = new ModelRouter(
    [
      fake('nano', 0, ['visual-verdict'], () => ({ verdict: 'uncertain', summary: '', issues: [] })),
      fake('google-cli', 1, ['visual-verdict'], () => ({ verdict: 'uncertain', summary: '', issues: [] })),
      fake('anthropic(x)', 2, ['visual-verdict'], () => ({ verdict: 'pass', summary: 'ok', issues: [] })),
    ],
    { pinnedAdapter: 'anthropic(x)' },
  );
  await router.visualVerdict(png, 'ok?', 1);
  check('visual ladder: Nano first', router.trace[0].adapter === 'nano');
  check('visual ladder: pinned is second (before rung-1)', router.trace[1].adapter === 'anthropic(x)');
}

{
  // fallback intact: an UNAVAILABLE pin is skipped, the ladder still plans
  const router = new ModelRouter(
    [
      fake('google-cli', 1, ['plan-step'], () => okPlan),
      fake('anthropic(x)', 2, ['plan-step'], () => okPlan, false), // not available
    ],
    { pinnedAdapter: 'anthropic(x)' },
  );
  await router.planJson('plan!', {}, 1);
  check('unavailable pin falls back to the ladder', router.trace[0].adapter === 'google-cli');
}

/* ---------- part 2: API adapters build the right request (mocked fetch) ---------- */

const realFetch = globalThis.fetch;
type FetchCall = { url: string; init: RequestInit };

async function withMockFetch(body: unknown, fn: () => Promise<void>): Promise<FetchCall> {
  const captured: FetchCall = { url: '', init: {} };
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    captured.url = String(url);
    captured.init = init;
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
  return captured;
}

{
  const adapter = new AnthropicAdapter({ apiKey: 'sk-test', model: 'claude-haiku-4-5' });
  let result: unknown;
  const call = await withMockFetch(
    { content: [{ type: 'text', text: '{"verdict":"pass","summary":"ok","issues":[]}' }], usage: { input_tokens: 5, output_tokens: 3 } },
    async () => {
      result = await adapter.generateJson({ prompt: 'judge', schema: { type: 'object' }, imagePng: png });
    },
  );
  const headers = (call.init.headers ?? {}) as Record<string, string>;
  const sentBody = JSON.parse(String(call.init.body)) as { model: string; messages: { content: { type: string }[] }[] };
  check('anthropic: posts to the Messages endpoint', call.url === 'https://api.anthropic.com/v1/messages');
  check('anthropic: sends x-api-key + anthropic-version', headers['x-api-key'] === 'sk-test' && headers['anthropic-version'] === '2023-06-01');
  check('anthropic: image becomes a base64 content block', sentBody.messages[0].content.some((b) => b.type === 'image'));
  check('anthropic: parses the verdict JSON', (result as { verdict?: string }).verdict === 'pass');
  check('anthropic: records token usage', adapter.lastUsage?.promptTokens === 5 && adapter.lastUsage?.outputTokens === 3);
}

{
  const adapter = new OpenAiCompatibleAdapter({ apiKey: 'sk-oai', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', label: 'gpt' });
  let result: unknown;
  const call = await withMockFetch(
    { choices: [{ message: { content: JSON.stringify(okPlan) } }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
    async () => {
      result = await adapter.generateJson({ prompt: 'plan', schema: { type: 'object' }, imagePng: png });
    },
  );
  const headers = (call.init.headers ?? {}) as Record<string, string>;
  const sentBody = JSON.parse(String(call.init.body)) as { response_format?: { type: string }; messages: { content: { type: string }[] }[] };
  check('openai-compat: posts to /chat/completions', call.url === 'https://api.openai.com/v1/chat/completions');
  check('openai-compat: sends Bearer auth', headers['authorization'] === 'Bearer sk-oai');
  check('openai-compat: requests json_object response_format', sentBody.response_format?.type === 'json_object');
  check('openai-compat: image becomes an image_url block', sentBody.messages[0].content.some((b) => b.type === 'image_url'));
  check('openai-compat: parses the plan JSON', Array.isArray((result as { actions?: unknown[] }).actions));
  check('openai-compat: records token usage', adapter.lastUsage?.totalTokens === 8);
}

{
  // GLM (z.ai) — a text-only OpenAI-compatible model: supportsVision:false means
  // it plans but never judges screenshots, sends NO image even when one is passed,
  // and merges extraBody (thinking disabled) into the chat-completions body.
  const adapter = new OpenAiCompatibleAdapter({
    apiKey: 'glm-test',
    model: 'glm-5.2',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    label: 'glm',
    supportsVision: false,
    extraBody: { thinking: { type: 'disabled' } },
  });
  check('glm: supports plan-step', adapter.supports('plan-step'));
  check('glm: does NOT support visual-verdict (text-only)', !adapter.supports('visual-verdict'));
  let result: unknown;
  const call = await withMockFetch(
    { choices: [{ message: { content: JSON.stringify(okPlan) } }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
    async () => {
      // pass an image: a text-only adapter must drop it rather than send it.
      result = await adapter.generateJson({ prompt: 'plan', schema: { type: 'object' }, imagePng: png });
    },
  );
  const sentBody = JSON.parse(String(call.init.body)) as {
    model: string;
    thinking?: { type: string };
    messages: { content: { type: string }[] }[];
  };
  check('glm: posts to z.ai /chat/completions', call.url === 'https://api.z.ai/api/paas/v4/chat/completions');
  check('glm: uses the glm-5.2 model id', sentBody.model === 'glm-5.2');
  check('glm: sends NO image block (text-only)', !sentBody.messages[0].content.some((b) => b.type === 'image_url'));
  check('glm: merges extraBody (thinking disabled)', sentBody.thinking?.type === 'disabled');
  check('glm: parses the plan JSON', Array.isArray((result as { actions?: unknown[] }).actions));
}

/* ---------- part 3: model-id sanitization (command-injection guard) ---------- */

{
  const good = ['claude-haiku-4-5', 'gemini-3-flash-preview', 'anthropic/claude-3.5-haiku', 'gpt-4o-mini'];
  const bad = ['x & calc.exe', 'a;b', '`id`', '$(reboot)', 'm | n', 'a b', 'm\nn', "m'"];
  check('isSafeModelId accepts real model ids', good.every(isSafeModelId));
  check('isSafeModelId rejects shell metacharacters', bad.every((m) => !isSafeModelId(m)));
}

{
  // a tainted model must NOT reach the shell — generateJson throws before spawn
  const adapter = new CliPlannerAdapter({ bin: 'claude', model: 'haiku & calc.exe' });
  let threw = false;
  try {
    await adapter.generateJson({ prompt: 'p', schema: { type: 'object' } });
  } catch (e) {
    threw = /unsafe model/.test((e as Error).message);
  }
  check('cli-planner refuses to spawn with an unsafe model id', threw);
}

{
  // unconfigured API adapters report unavailable (clean skip, no throw)
  const a = new AnthropicAdapter({ apiKey: undefined, model: 'claude-haiku-4-5' });
  const o = new OpenAiCompatibleAdapter({ apiKey: undefined, model: 'm', baseUrl: 'https://x/v1', label: 'openrouter' });
  check('adapters without a key are unavailable', !(await a.available()) && !(await o.available()));
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
