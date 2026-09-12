/* V95 — the default for the model that CLICKS (audit finding A13).
 *
 * The per-step role is the entire cost lever: it is called on every single
 * step, where the planning model is called a handful of times per run. It used
 * to default to the on-device model, unconditionally, on both the "missing
 * setting" migration path and in the desktop helper's own defaults.
 *
 * That is free ONLY on a machine that can actually host the on-device model.
 * Everywhere else the pin is silently skipped by the ladder and the user's
 * expensive planning model drives every step instead — with the panel still
 * showing the on-device pin. The cost lever evaporates without a word.
 *
 * This suite pins the fix:
 *   1. the derived default — the cheap/fast tier of whatever provider is
 *      configured for planning, on the same transport;
 *   2. a settings file with NO setting for the model that clicks migrates to
 *      that cloud default, not to the on-device model, and the on-device model
 *      survives as an explicit choice;
 *   3. the desktop helper's own defaults agree with that migration;
 *   4. a pinned-but-unavailable model plus a real ladder fall-through produces
 *      a loud one-line warning naming BOTH models.
 *
 * Pure/in-memory: a temp settings file and stub adapters. No Chrome, no
 * network, no API keys.
 *
 * Run: npx tsx test/v95.navigator-default.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SettingsStore, navigatorDefaultForBrain, type PlannerSelection } from '../src/vibe/settings.js';
import { loadConfig } from '../src/config.js';
import { navigatorFallbackWarning } from '../src/engine.js';
import { ModelRouter } from '../src/router/model-router.js';
import type { Capability, ModelAdapter } from '../src/router/adapter.js';

let failures = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => console.log(`PASS  ${name}`),
      (e) => {
        failures++;
        console.log(`FAIL  ${name}: ${e instanceof Error ? e.message : String(e)}`);
      },
    );
}

const CLI_BRAIN: PlannerSelection = { provider: 'claude', mode: 'cli', model: '' };

// ---- 1. the derived default ------------------------------------------------

await check('a command-line planning model gives the same provider/transport, cheap tier', () => {
  const nav = navigatorDefaultForBrain(CLI_BRAIN, CLI_BRAIN);
  assert.equal(nav.provider, 'claude');
  assert.equal(nav.mode, 'cli');
  assert.equal(nav.model, 'claude-haiku-4-5');
});

await check('a key-based planning model keeps the key transport', () => {
  const nav = navigatorDefaultForBrain({ provider: 'claude', mode: 'api', model: 'claude-sonnet-5' }, CLI_BRAIN);
  assert.equal(nav.provider, 'claude');
  assert.equal(nav.mode, 'api');
  assert.equal(nav.model, 'claude-haiku-4-5');
});

await check('another provider derives from ITS own cheap tier, needing no extra credentials', () => {
  const nav = navigatorDefaultForBrain({ provider: 'gemini', mode: 'api', model: '' }, CLI_BRAIN);
  assert.equal(nav.provider, 'gemini');
  assert.equal(nav.model, 'gemini-3-flash-preview');
});

await check('the on-device model is never derived automatically', () => {
  for (const brain of [
    CLI_BRAIN,
    { provider: 'gemini', mode: 'api', model: '' } as PlannerSelection,
    { provider: 'nano', mode: 'ondevice', model: '' } as unknown as PlannerSelection,
  ]) {
    assert.notEqual(navigatorDefaultForBrain(brain, CLI_BRAIN).provider, 'nano');
  }
});

// ---- 2. the migration ------------------------------------------------------

function withSettingsFile(contents: unknown, fn: (store: SettingsStore, file: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-v95-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(contents, null, 2));
  try {
    fn(new SettingsStore(file), file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

await check('a settings file with no model-that-clicks migrates to the cloud default', () => {
  withSettingsFile({ planner: { provider: 'claude', mode: 'cli', model: '' } }, (store, file) => {
    const raw = store.readRaw();
    assert.ok(raw.navigator, 'a value was filled in');
    assert.notEqual(raw.navigator!.provider, 'nano', 'and it is NOT the on-device model');
    assert.equal(raw.navigator!.provider, 'claude');
    assert.equal(raw.navigator!.mode, 'cli');
    assert.equal(raw.navigator!.model, 'claude-haiku-4-5');
    // ...and it was written back to disk once, so every other reader agrees.
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.navigator.provider, 'claude');
  });
});

await check('a dead planning pin is fixed FIRST, and the derived default follows the fixed one', () => {
  withSettingsFile({ planner: { provider: 'gemini', mode: 'cli', model: '' } }, (store) => {
    const raw = store.readRaw();
    assert.equal(raw.planner!.provider, 'claude');
    assert.equal(raw.planner!.mode, 'cli');
    assert.equal(raw.navigator!.provider, 'claude', 'derived from the FIXED brain, not the dead one');
    assert.equal(raw.navigator!.mode, 'cli');
  });
});

await check('an explicit on-device choice is left alone', () => {
  withSettingsFile(
    { planner: { provider: 'claude', mode: 'cli', model: '' }, navigator: { provider: 'nano', mode: 'ondevice', model: '' } },
    (store) => {
      assert.equal(store.readRaw().navigator!.provider, 'nano');
      assert.equal(store.read().navigator.provider, 'nano');
    },
  );
});

// ---- 3. the helper's own defaults agree ------------------------------------

await check("the desktop helper's own default for the model that clicks is not on-device either", () => {
  // An empty settings path so nothing on this machine leaks into the answer.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-v95-cfg-'));
  const prevLocal = process.env.LOCALAPPDATA;
  const prevHome = process.env.HOME;
  const pins = ['SPIKE_NAVIGATOR_PROVIDER', 'SPIKE_NAVIGATOR_MODE', 'SPIKE_NAVIGATOR_MODEL'] as const;
  const saved = pins.map((k) => [k, process.env[k]] as const);
  try {
    process.env.LOCALAPPDATA = dir;
    process.env.HOME = dir;
    for (const k of pins) delete process.env[k];
    const cfg = loadConfig({});
    assert.notEqual(cfg.navigator?.provider, 'nano');
    assert.equal(cfg.navigator?.provider, 'claude');
    assert.equal(cfg.navigator?.mode, 'cli');
  } finally {
    if (prevLocal === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = prevLocal;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 4. the loud fall-through warning --------------------------------------

function stubAdapter(name: string, rung: number, available: boolean): ModelAdapter {
  return {
    name,
    rung,
    supports: (cap: Capability) => cap !== 'visual-verdict',
    available: async () => available,
    generateJson: async () => ({}),
  } as unknown as ModelAdapter;
}

await check('a pinned model that cannot run here warns, naming both models', async () => {
  const router = new ModelRouter([stubAdapter('nano', 0, false), stubAdapter('claude', 2, true)], {
    navigatorAdapter: 'nano',
  });
  const actual = await router.resolveLead('plan-step');
  assert.equal(actual, 'claude', 'the ladder really did fall through');
  const warning = navigatorFallbackWarning('nano', actual);
  assert.ok(warning, 'a warning was produced');
  assert.ok(warning!.includes('nano'), 'names the pinned model');
  assert.ok(warning!.includes('claude'), 'names the one actually used');
  assert.ok(/pay/i.test(warning!), 'says it costs money');
  assert.equal(warning!.split('\n').length, 1, 'one line');
});

await check('a pin that IS in effect stays quiet', async () => {
  const router = new ModelRouter([stubAdapter('nano', 0, true), stubAdapter('claude', 2, true)], {
    navigatorAdapter: 'nano',
  });
  assert.equal(navigatorFallbackWarning('nano', await router.resolveLead('plan-step')), null);
});

await check('nothing to say when there is no pin, or nothing can run at all', () => {
  assert.equal(navigatorFallbackWarning(undefined, 'claude'), null);
  assert.equal(navigatorFallbackWarning('nano', undefined), null);
});

console.log(failures === 0 ? '\nV95 OK' : `\nV95 FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
