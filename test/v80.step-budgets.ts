/* V80 — budget surfaces (audit finding A8).
 *
 * The per-sub-goal step cap was hardcoded at 12 with no surface anywhere: no
 * env var, no config key, no flag. On anything bigger than the dogfood fixture
 * that made a slow-but-progressing goal indistinguishable from a stuck one, and
 * there was no way to buy more room short of editing the source.
 *
 * This suite pins the new surface:
 *   1. SPIKE_PER_GOAL_MAX_STEPS / the `perGoalMaxSteps` config key are read,
 *      with 12 as the default;
 *   2. resolveStepBudgets() reconciles the two budgets in one place — a per-run
 *      option beats config, and a per-goal cap is always clamped to the run
 *      budget (which reproduces the OLD hardcoded behaviour at the defaults, so
 *      configuring nothing changes nothing);
 *   3. what it produces is LoopOptions-shaped and really is what the engine
 *      spreads into the driver loop;
 *   4. the qa_run tool's step budget actually admits a long journey (cap 200,
 *      and its description no longer claims a default of 12).
 *
 * Pure: no Chrome, no AI, no network. `loadConfig` runs against a scratch
 * directory so a developer's own spike.config.json cannot swing it.
 *
 * Run: npx tsx test/v80.step-budgets.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveStepBudgets } from '../src/config.js';
import type { LoopOptions } from '../src/driver/loop.js';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}: ${e instanceof Error ? e.message : e}`);
  }
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-budget-'));

/** loadConfig with a controlled environment and no stray config file. */
function configWith(env: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return loadConfig({}, scratch);
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/* ---- 1) the env var and the config key are real -------------------------- */

check('the per-sub-goal budget defaults to 12 and the run budget to 40', () => {
  const cfg = configWith({ SPIKE_MAX_STEPS: undefined, SPIKE_PER_GOAL_MAX_STEPS: undefined });
  assert.equal(cfg.perGoalMaxSteps, 12);
  assert.equal(cfg.maxSteps, 40);
});

check('SPIKE_PER_GOAL_MAX_STEPS is read into the config', () => {
  const cfg = configWith({ SPIKE_PER_GOAL_MAX_STEPS: '30' });
  assert.equal(cfg.perGoalMaxSteps, 30);
});

check('the perGoalMaxSteps config key is read from spike.config.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-budget-file-'));
  fs.writeFileSync(path.join(dir, 'spike.config.json'), JSON.stringify({ perGoalMaxSteps: 25, maxSteps: 120 }));
  const saved = process.env.SPIKE_PER_GOAL_MAX_STEPS;
  delete process.env.SPIKE_PER_GOAL_MAX_STEPS;
  try {
    const cfg = loadConfig({}, dir);
    assert.equal(cfg.perGoalMaxSteps, 25);
    assert.equal(cfg.maxSteps, 120);
  } finally {
    if (saved !== undefined) process.env.SPIKE_PER_GOAL_MAX_STEPS = saved;
  }
});

/* ---- 2) the env var reaches LoopOptions ---------------------------------- */

check('the env var flows all the way into the options the driver loop receives', () => {
  const cfg = configWith({ SPIKE_PER_GOAL_MAX_STEPS: '30', SPIKE_MAX_STEPS: '150' });
  // exactly what src/engine.ts spreads into runDriverLoop
  const loopOpts: LoopOptions = resolveStepBudgets(cfg, { maxSteps: undefined, perGoalMaxSteps: undefined });
  assert.equal(loopOpts.perGoalMaxSteps, 30);
  assert.equal(loopOpts.maxSteps, 150);
});

check('a per-run option beats the configured value', () => {
  const cfg = configWith({ SPIKE_PER_GOAL_MAX_STEPS: '30', SPIKE_MAX_STEPS: '150' });
  const loopOpts = resolveStepBudgets(cfg, { maxSteps: 80, perGoalMaxSteps: 20 });
  assert.deepEqual(loopOpts, { maxSteps: 80, perGoalMaxSteps: 20 });
});

check('the per-goal cap can never exceed the run it lives in', () => {
  assert.deepEqual(resolveStepBudgets({ maxSteps: 10, perGoalMaxSteps: 40 }), { maxSteps: 10, perGoalMaxSteps: 10 });
  // the old hardcoded behaviour, reproduced exactly at the defaults
  assert.deepEqual(resolveStepBudgets({ maxSteps: 40, perGoalMaxSteps: 12 }), { maxSteps: 40, perGoalMaxSteps: 12 });
  assert.deepEqual(resolveStepBudgets({ maxSteps: 5, perGoalMaxSteps: 12 }), { maxSteps: 5, perGoalMaxSteps: 5 });
});

check('nonsense values fall back to the defaults instead of disabling the budget', () => {
  const cfg = configWith({ SPIKE_PER_GOAL_MAX_STEPS: 'lots', SPIKE_MAX_STEPS: '0' });
  const loopOpts = resolveStepBudgets(cfg);
  assert.equal(loopOpts.maxSteps, 40);
  assert.equal(loopOpts.perGoalMaxSteps, 12);
});

check('the engine really builds its loop options from resolveStepBudgets', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'src', 'engine.ts'), 'utf8');
  assert.ok(
    /\.\.\.resolveStepBudgets\(cfg, \{ maxSteps: opts\.maxSteps, perGoalMaxSteps: opts\.perGoalMaxSteps \}\)/.test(src),
    'the runDriverLoop call site no longer spreads resolveStepBudgets — the surface is disconnected',
  );
});

/* ---- 3) the tool's budget admits a long journey -------------------------- */

check('qa_run accepts a step budget up to 200 and documents the real default', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'src', 'mcp-server.ts'), 'utf8');
  assert.ok(/\.max\(200\)/.test(src), 'the qa_run step budget is still capped below its own default');
  assert.ok(/default 40/.test(src), 'the qa_run step budget description does not state the real default');
  assert.ok(!/default 12/.test(src), 'the stale "default 12" is still in the qa_run description');
});

check('the docs describe the budgets as configurable, with the real defaults', () => {
  const overview = fs.readFileSync(path.join(repoRoot, 'docs', 'overview.md'), 'utf8');
  const env = fs.readFileSync(path.join(repoRoot, 'docs', 'infra', 'environment.md'), 'utf8');
  assert.ok(/SPIKE_PER_GOAL_MAX_STEPS/.test(overview), 'overview.md never mentions the per-sub-goal budget');
  assert.ok(/default 40, SPIKE_MAX_STEPS/.test(overview), 'overview.md still claims the old step-budget default');
  assert.ok(/SPIKE_PER_GOAL_MAX_STEPS - Integer/.test(env), 'environment.md never documents the new variable');
  assert.ok(!/cfg\.maxSteps\. Default: 12/.test(env), 'environment.md still claims the old step-budget default');
});

if (failures) {
  console.error(`\nV80: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nV80: all checks passed');
