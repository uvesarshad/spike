/* v107 — A17 (P1): the "what should be true at the end?" input surface.
 *
 * The prompt side of A17 landed earlier (v88): given an `expectations` string,
 * both models are shown a REQUIRED FINAL CHECKS section and told to prove each
 * line with a precise check rather than eyeball the page. What was missing was
 * any way for a person to SET that string — it was reachable only by calling
 * the driver loop directly, which no shipped surface does. This suite covers
 * the three input surfaces and the hop each one takes to the driver:
 *
 *   1. `spike run --expect "<text>"`      → QaRunOptions.expectations
 *   2. the qa_run tool's `expect` input   → QaRunOptions.expectations
 *   3. the panel's optional field         → the run payload → both engines
 *   4. QaRunOptions.expectations          → LoopOptions.expectations
 *
 * cli.ts and mcp-server.ts cannot be imported (one parses argv at load, the
 * other opens a stdio transport), and the panel/service-worker files need a
 * live Chrome, so those hops are asserted at source level — the same guard
 * style v72 uses for look-only mode. The last hop, the one that actually
 * decides whether any of this reaches a model, is exercised for real: an
 * expectations string handed to the prompt builders must come back out in the
 * prompt, and a blank one must leave both prompts untouched.
 *
 * Pure: no Chrome, no network, no model calls.
 * Run: npx tsx test/v107.expect-input.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGoalPlannerPrompt, buildNavigatorPrompt } from '../src/driver/planner-prompt.js';
import type { LoopOptions } from '../src/driver/loop.js';
import type { QaRunOptions } from '../src/engine.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p: string[]) => fs.readFileSync(path.join(repoRoot, ...p), 'utf8');

const SENTENCE = 'cart shows 2 items';

// ---- 1. the command line ---------------------------------------------------
console.log('=== v107 1/5: spike run --expect ===');
{
  const cli = read('src', 'cli.ts');
  check("cli.ts declares --expect on the run command", /\.option\('--expect <text>'/.test(cli));
  check(
    'the flag is forwarded to the run as `expectations`',
    /\.\.\.\(opts\.expect\?\.trim\(\) && \{ expectations: opts\.expect\.trim\(\) \}\)/.test(cli),
  );
  check("the parsed options type carries `expect`", /expect\?: string;/.test(cli));

  const helpLine = cli.split('\n').find((l) => l.includes(".option('--expect <text>'")) ?? '';
  check('the help text asks for plain English', /plain English/.test(helpLine));
  // §1.5: the help a person reads must not name the machinery.
  const banned = ['oracle', 'invariant', 'assertion verb', 'navigator', 'brain', 'planner', 'metamorphic'];
  for (const word of banned) {
    check(`--expect help avoids "${word}"`, !helpLine.toLowerCase().includes(word));
  }
}

// ---- 2. the qa_run tool ----------------------------------------------------
console.log('\n=== v107 2/5: the qa_run tool input ===');
{
  const mcp = read('src', 'mcp-server.ts');
  check(
    'qa_run exposes an optional `expect` string',
    /expect: z\s*\n?\s*\.string\(\)\s*\n?\s*\.optional\(\)/.test(mcp),
  );
  check('the handler destructures it', /async \(\{[^}]*\bexpect\b[^}]*\}\) =>/.test(mcp));
  check(
    'it is forwarded to the run as `expectations`',
    /\.\.\.\(expect\?\.trim\(\) && \{ expectations: expect\.trim\(\) \}\)/.test(mcp),
  );
  // The tool description is read by another model, so it may be precise — but
  // the run options it builds are shared with the flows/spec path, which is the
  // whole point of describing the input as applying to every flow.
  check('the description says it applies to every flow too', /applies to every flow/.test(mcp));
}

// ---- 3. the panel field ----------------------------------------------------
console.log('\n=== v107 3/5: the panel field ===');
{
  const html = read('extension', 'panel.html');
  check('panel.html asks the agreed question', html.includes('What should be true at the end? (optional)'));
  check('it is a labelled text field on the task box', /<input id="expect"[^>]*type="text"/.test(html));
  check('the label points at the field', /for="expect"/.test(html));
  check('the placeholder is an example, not instructions', /placeholder="e\.g\. the cart shows 2 items/.test(html));

  const panel = read('extension', 'panel.js');
  check('panel.js reads the field', /const expectInput = \$\('expect'\)/.test(panel));
  check('the run message carries it when the user wrote one', /if \(expectText\) runMsg\.expect = expectText;/.test(panel));
  check('a site check (nobody typed a task) carries none', /flowQueue && flowQueue\.lookOnly\) && expectInput/.test(panel));

  const sw = read('extension', 'sw.js');
  check(
    'the desktop helper is sent the sentence',
    /runParams\.expect = msg\.expect\.trim\(\);/.test(sw),
  );
  check(
    'the browser-only engine is given it as `expectations`',
    /\{ expectations: msg\.expect\.trim\(\) \}/.test(sw),
  );
  check(
    'both are omitted when the field is blank, so nothing changes for an older helper',
    /typeof msg\.expect === 'string' && msg\.expect\.trim\(\)/.test(sw),
  );

  // The two engines behind the panel must accept what the worker sends.
  const service = read('src', 'vibe', 'service.ts');
  check('the desktop helper reads `expect` off the run request', /\.expect\b/.test(service));
  check('…and hands it to the run as `expectations`', /\.\.\.\(expectations && \{ expectations \}\)/.test(service));
  const lite = read('src', 'extension', 'lite-engine.ts');
  check('the browser-only engine accepts `expectations`', /expectations\?: string;/.test(lite));
  check(
    '…and hands it to the driver',
    /\.\.\.\(opts\.expectations\?\.trim\(\) && \{ expectations: opts\.expectations\.trim\(\) \}\)/.test(lite),
  );
}

// ---- 4. the engine hop -----------------------------------------------------
console.log('\n=== v107 4/5: the run option reaches the driver ===');
{
  const engine = read('src', 'engine.ts');
  check('QaRunOptions declares `expectations`', /expectations\?: string;/.test(engine));
  check(
    'the driver call forwards it',
    /\.\.\.\(opts\.expectations\?\.trim\(\) && \{ expectations: opts\.expectations \}\)/.test(engine),
  );
  // A17's other half: the per-project tuning for the page checks was readable
  // from a config file and accepted by the driver, but nothing joined the two.
  check('the per-project page-check tuning is forwarded too', /\{ invariants: cfg\.invariants \}/.test(engine));

  // The types line up: what the CLI/tool/panel set is what the driver reads.
  const runOpts: QaRunOptions = { expectations: SENTENCE };
  const loopOpts: LoopOptions = { expectations: runOpts.expectations };
  check('a run option is a valid driver option', loopOpts.expectations === SENTENCE);
}

// ---- 5. and it actually reaches both models --------------------------------
console.log('\n=== v107 5/5: the sentence lands in the prompts ===');
{
  const brain = buildGoalPlannerPrompt({ task: 'buy a widget', url: 'https://shop.test/', axText: 'n1 button "Buy"', expectations: SENTENCE });
  const nav = buildNavigatorPrompt({
    task: 'buy a widget',
    goal: 'add a widget to the cart',
    goals: ['add a widget to the cart'],
    currentGoal: 0,
    history: [],
    stepIndex: 0,
    url: 'https://shop.test/',
    axText: 'n1 button "Buy"',
    maxSteps: 40,
    expectations: SENTENCE,
  });
  check('the planning model is told what must be true', brain.includes(SENTENCE));
  check('the model driving the page is told too', nav.includes(SENTENCE));
  const blankBrain = buildGoalPlannerPrompt({ task: 'buy a widget', url: 'https://shop.test/', axText: 'n1 button "Buy"', expectations: '   ' });
  check('a blank field leaves the run exactly as it was', !blankBrain.includes('REQUIRED FINAL CHECKS'));
}

// ---- summary ---------------------------------------------------------------
const failed = checks.filter(([, ok]) => !ok);
console.log(`\nv107: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
