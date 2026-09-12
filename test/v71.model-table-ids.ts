/* v71 — Model table safety + freshness (A31).
 *
 * Covers:
 *   1. every default model id in NAVIGATOR_MODELS/BRAIN_MODELS (reached via
 *      defaultModelFor for every provider+mode pairing PROVIDER_MODES exposes)
 *      passes isSafeModelId — a table entry that fails this would be rejected
 *      at runtime by the same command-injection guard (see settings-data.ts's
 *      isSafeModelId doc comment).
 *   2. the OpenRouter defaults specifically are pinned to the current
 *      Anthropic generation (claude-haiku-4-5 / claude-sonnet-5), not a stale
 *      3.5-era slug.
 *
 * Pure/in-memory — no Chrome, no network, no ports. Fast bucket.
 */

import {
  defaultModelFor,
  isSafeModelId,
  PROVIDER_MODES,
  type ProviderId,
  type PlannerMode,
} from '../src/vibe/settings-data.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

for (const [provider, modes] of Object.entries(PROVIDER_MODES) as [ProviderId, string[]][]) {
  for (const mode of modes) {
    for (const role of ['navigator', 'brain'] as const) {
      const model = defaultModelFor(provider, mode as PlannerMode, role);
      if (model === '') continue; // e.g. gpt:cli — codex uses its own configured model, nothing to validate
      check(`${provider}:${mode} (${role}) default "${model}" passes isSafeModelId`, isSafeModelId(model));
    }
  }
}

check(
  'openrouter navigator default is the current Anthropic generation (claude-haiku-4-5)',
  defaultModelFor('openrouter', 'api', 'navigator') === 'anthropic/claude-haiku-4-5',
);
check(
  'openrouter brain default is the current Anthropic generation (claude-sonnet-5)',
  defaultModelFor('openrouter', 'api', 'brain') === 'anthropic/claude-sonnet-5',
);

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v71 checks passed`);
process.exit(failed.length ? 1 : 0);
