/* v88 — A17 (P1): reachable precise assertions, and a way to say what "correct"
 * means for THIS app.
 *
 * Three separate gaps, one finding:
 *   1. six precise assertion verbs were fully implemented but named in no
 *      prompt, so no model could ever ask for one — every run collapsed to a
 *      page-health smoke test plus one model-judged screenshot;
 *   2. there was no way for the person asking for the run to say what must be
 *      true at the end, so "check the checkout works" had no pass criteria
 *      beyond the model's opinion;
 *   3. the per-project tuning for the deterministic page checks existed as a
 *      type and was never read from anywhere, so a glossary or a JS tutorial
 *      that legitimately renders the word "undefined" was reported as broken on
 *      every single step.
 *
 * Covers (pure — no Chrome, no AI, no network):
 *   - the navigator's vocabulary carries one worked example of each of the six
 *     verbs, and the response schema still admits all six;
 *   - both prompts grow a REQUIRED FINAL CHECKS section when (and only when)
 *     expectations were given;
 *   - allow-listed text is not reported, while the same text un-allow-listed is;
 *   - the allow-list is readable from the environment and from the config file,
 *     and garbage in either list is dropped rather than reaching the checker.
 *
 * Run: npx tsx test/v88.precise-assertions.ts   (exits nonzero on any failed check)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { ACTION_RULES_AND_VOCABULARY, buildGoalPlannerPrompt, buildNavigatorPrompt } from '../src/driver/planner-prompt.js';
import { PLAN_JSON_SCHEMA } from '../src/driver/actions.js';
import { checkProbeInvariants } from '../src/assertions/invariants.js';
import type { LoopOptions } from '../src/driver/loop.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const VERBS = ['assert_text', 'assert_count', 'assert_url', 'assert_state', 'assert_network', 'assert_no_console_errors'] as const;

console.log('=== v88 1/4: the six precise verbs are teachable ===');
{
  for (const verb of VERBS) {
    check(`${verb} appears in the vocabulary`, ACTION_RULES_AND_VOCABULARY.includes(verb));
    check(
      `${verb} has a worked JSON example`,
      ACTION_RULES_AND_VOCABULARY.includes(`{"type":"${verb}"`),
    );
    check(
      `${verb} is still accepted by the response schema`,
      (PLAN_JSON_SCHEMA.properties.actions.items.properties.type.enum as readonly string[]).includes(verb),
    );
  }
  check(
    'the vocabulary says to prefer a precise verb over the loose text check',
    /PREFER a precise assertion verb/.test(ACTION_RULES_AND_VOCABULARY),
  );
}

console.log('\n=== v88 2/4: "what should be true at the end?" reaches both prompts ===');
{
  const base = {
    task: 'buy a widget',
    url: 'https://shop.example.com/',
    axText: 'n1 button "Buy"',
  };
  const expectations = 'The order confirmation shows a total of $49.99 and the cart badge reads 0.';

  const brainWith = buildGoalPlannerPrompt({ ...base, expectations });
  const brainWithout = buildGoalPlannerPrompt(base);
  check('the brain prompt carries a REQUIRED FINAL CHECKS section', brainWith.includes('REQUIRED FINAL CHECKS'));
  check('the brain prompt quotes the expectations verbatim', brainWith.includes(expectations));
  check('no expectations given → the brain prompt is unchanged', !brainWithout.includes('REQUIRED FINAL CHECKS'));
  check('blank expectations are treated as none', !buildGoalPlannerPrompt({ ...base, expectations: '   ' }).includes('REQUIRED FINAL CHECKS'));

  const navBase = {
    ...base,
    goal: 'buy a widget',
    goals: ['buy a widget'],
    currentGoal: 0,
    history: [],
    stepIndex: 0,
    maxSteps: 10,
  };
  const navWith = buildNavigatorPrompt({ ...navBase, expectations });
  check('the navigator prompt carries the section too', navWith.includes('REQUIRED FINAL CHECKS'));
  check('the navigator is told to prove each one with a precise verb', navWith.includes('prove EVERY one of them with a precise assertion verb'));
  check('no expectations given → the navigator prompt is unchanged', !buildNavigatorPrompt(navBase).includes('REQUIRED FINAL CHECKS'));

  // the driver accepts both new run inputs
  const opts: LoopOptions = { expectations, invariants: { allowText: ['undefined behaviour'] } };
  check('the driver accepts expectations and the page-check tuning as run inputs', opts.expectations === expectations && opts.invariants?.allowText?.length === 1);
}

console.log('\n=== v88 3/4: allow-listed text is not reported ===');
{
  const probeOutput = {
    renderedUndefined: ['The `undefined` value in JavaScript', 'Total: undefined'],
  };
  const unfiltered = checkProbeInvariants(probeOutput);
  check('without an allow-list both occurrences are reported', unfiltered.filter((v) => v.rule === 'rendered-undefined').length === 2);

  const filtered = checkProbeInvariants(probeOutput, { allowText: ['The `undefined` value in JavaScript'] });
  const reported = filtered.filter((v) => v.rule === 'rendered-undefined');
  check('the allow-listed line is not reported', reported.length === 1);
  check('the genuinely broken line still is', reported[0]?.evidence?.includes('Total: undefined') === true);

  const disabled = checkProbeInvariants(probeOutput, { disabled: ['rendered-undefined'] });
  check('a disabled rule reports nothing at all', disabled.every((v) => v.rule !== 'rendered-undefined'));
}

console.log('\n=== v88 4/4: the tuning is readable from the environment and the config file ===');
{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-inv-'));
  const saved = process.env.SPIKE_INVARIANT_ALLOW_TEXT;

  delete process.env.SPIKE_INVARIANT_ALLOW_TEXT;
  check('nothing configured → nothing skipped and nothing allowed', JSON.stringify(loadConfig({}, scratch).invariants) === '{}');

  process.env.SPIKE_INVARIANT_ALLOW_TEXT = 'undefined behaviour, NaN (the number), ,';
  const fromEnv = loadConfig({}, scratch).invariants;
  check('the environment allow-list is read and trimmed', JSON.stringify(fromEnv.allowText) === JSON.stringify(['undefined behaviour', 'NaN (the number)']));
  delete process.env.SPIKE_INVARIANT_ALLOW_TEXT;

  fs.writeFileSync(
    path.join(scratch, 'spike.config.json'),
    JSON.stringify({ invariants: { disabled: ['layout-overflow', 42], allowText: ['[object Object] — our mascot', '  '] } }),
  );
  const fromFile = loadConfig({}, scratch).invariants;
  check('the config file supplies both lists', JSON.stringify(fromFile.disabled) === JSON.stringify(['layout-overflow']));
  check('non-strings and blanks are dropped before the checker sees them', JSON.stringify(fromFile.allowText) === JSON.stringify(['[object Object] — our mascot']));

  if (saved === undefined) delete process.env.SPIKE_INVARIANT_ALLOW_TEXT;
  else process.env.SPIKE_INVARIANT_ALLOW_TEXT = saved;
  fs.rmSync(scratch, { recursive: true, force: true });
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) process.exit(1);
