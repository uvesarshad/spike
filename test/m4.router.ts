/* M4 verification —
 * Part 1 (always runs): escalation policy with fake adapters, no external deps.
 * Part 2 (live, skips gracefully): Google CLI adapter returns a real JSON
 * verdict on the spike's bad.png screenshot. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import type { Capability, JsonRequest, ModelAdapter } from '../src/router/adapter.js';
import { extractJson } from '../src/router/adapter.js';
import { GoogleCliAdapter } from '../src/router/adapters/google-cli.js';
import { ModelRouter } from '../src/router/model-router.js';
import { VERDICT_JSON_SCHEMA, verdictPrompt } from '../src/router/verdict.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

/* ---------- part 1: escalation policy ---------- */

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

{
  // uncertain rung-0 verdict escalates to rung 1
  const router = new ModelRouter([
    fake('nano-fake', 0, ['visual-verdict'], () => ({ verdict: 'uncertain', summary: 'hmm', issues: [] })),
    fake('flash-fake', 1, ['visual-verdict', 'plan-step'], () => ({ verdict: 'fail', summary: 'broken', issues: ['x'] })),
  ]);
  const v = await router.visualVerdict(png, 'page ok?', 1);
  check('uncertain rung-0 escalates to rung 1', v.verdict === 'fail');
  check(
    'trace records the escalation',
    router.trace.length === 2 &&
      router.trace[0].adapter === 'nano-fake' &&
      router.trace[1].escalatedFrom === 'nano-fake',
  );
}

{
  // throwing rung-0 escalates; unavailable adapters are skipped
  const router = new ModelRouter([
    fake('nano-dead', 0, ['visual-verdict'], () => {
      throw new Error('boom');
    }),
    fake('flash-offline', 1, ['visual-verdict'], () => ({ verdict: 'pass', summary: '', issues: [] }), false),
    fake('byok-fake', 2, ['visual-verdict', 'plan-step'], () => ({ verdict: 'pass', summary: 'ok', issues: [] })),
  ]);
  const v = await router.visualVerdict(png, 'page ok?', 2);
  check('error escalates past unavailable adapter to rung 2', v.verdict === 'pass');
  check('skipped adapter never appears in trace', !router.trace.some((t) => t.adapter === 'flash-offline'));
}

{
  // rung 0 never plans; no planner → clean error
  const router = new ModelRouter([
    fake('nano-fake', 0, ['visual-verdict'], () => ({})),
  ]);
  let msg = '';
  try {
    await router.planJson('plan!', {}, 3);
  } catch (e) {
    msg = (e as Error).message;
  }
  check('no planner available → clean actionable error', msg.includes('no planner available'));
}

{
  // whole ladder uncertain → honest uncertain, no throw
  const router = new ModelRouter([
    fake('nano-fake', 0, ['visual-verdict'], () => ({ verdict: 'uncertain', summary: 'a', issues: [] })),
    fake('flash-fake', 1, ['visual-verdict'], () => ({ verdict: 'uncertain', summary: 'b', issues: [] })),
  ]);
  const v = await router.visualVerdict(png, 'page ok?', 4);
  check('all-uncertain ladder returns uncertain (not an error)', v.verdict === 'uncertain');
}

{
  // extractJson copes with prose and fences
  const cases: [string, boolean][] = [
    ['{"a":1}', true],
    ['Sure! ```json\n{"a":1}\n``` hope that helps', true],
    ['prefix {"a":{"b":2}} suffix', true],
  ];
  check(
    'extractJson handles bare/fenced/embedded JSON',
    cases.every(([s]) => {
      try {
        return typeof extractJson(s) === 'object';
      } catch {
        return false;
      }
    }),
  );
}

/* ---------- part 2: live google-cli (skips when absent) ---------- */

const cfg = loadConfig();
const cli = new GoogleCliAdapter({
  bin: cfg.googleCliBin,
  model: cfg.googleCliModel,
  env: cfg.googleCliEnv,
});

if (await cli.available()) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bad = path.join(here, '..', 'spikes', 'cdp-logpoint', 'shots', 'bad.png');
  if (fs.existsSync(bad)) {
    const t0 = Date.now();
    const raw = (await cli.generateJson({
      prompt: verdictPrompt('Does this dashboard page render correctly with no error messages?'),
      schema: VERDICT_JSON_SCHEMA,
      imagePng: fs.readFileSync(bad),
    })) as { verdict?: string };
    console.log(`live google-cli verdict in ${Date.now() - t0} ms:`, JSON.stringify(raw));
    check('live google-cli returns fail on bad.png', raw.verdict === 'fail');
  } else {
    console.log('SKIP  live google-cli (no bad.png — run spike capture-shots)');
  }
} else {
  console.log(`SKIP  live google-cli (${cfg.googleCliBin} not on PATH)`);
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
