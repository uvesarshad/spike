/* v37 — Recorded-script runtime validation (A14).
 *
 * `loadScript()` used to trust `JSON.parse(...) as QaScript` — a compile-time
 * assertion that does nothing at runtime. This suite exercises the real
 * validation gate added in src/recorder/schema.ts (`QaScriptSchema` /
 * `validateQaScript`) and its wiring into `loadScript()`:
 *
 *   1. a well-formed script covering every ScriptStep variant (including a
 *      nested `{type:'script'}` sub-DSL step) validates cleanly;
 *   2. an unknown/misspelled key is rejected outright (`.strict()`);
 *   3. a missing required field produces a readable, path-prefixed error;
 *   4. a wrong-typed field is rejected;
 *   5. a nested `script` step with an invalid sub-step is rejected via the
 *      REUSED `ScriptRunnerStepSchema` (not a re-described copy);
 *   6. `loadScript()` throws a clear, actionable error on a malformed file on
 *      disk and returns normally on a valid one;
 *   7. a script shaped exactly like `scriptFromReport`'s real output
 *      round-trips through validation (guards against the schema being
 *      STRICTER than what the recorder actually emits).
 *
 * Run: npx tsx test/v37.script-validation.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateQaScript, QaScriptSchema } from '../src/recorder/schema.js';
import { loadScript, scriptFromReport } from '../src/recorder/script.js';
import type { Report } from '../src/report/report.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

/* ===================== fixtures ===================== */

/** A well-formed script exercising every ScriptStep variant, including a
 * nested `script` sub-step. Mirrors script.ts:32-68 in order. */
function fullScript() {
  return {
    version: 1,
    name: 'full-flow',
    task: 'exercise every step type',
    url: 'http://localhost:3000/',
    sourceRunId: 'run-1',
    createdAt: new Date().toISOString(),
    steps: [
      { type: 'navigate', url: 'http://localhost:3000/login' },
      { type: 'click', target: { role: 'button', name: 'Sign in' } },
      { type: 'type', target: { role: 'textbox', name: 'Email', nth: 0 }, text: 'a@b.com' },
      { type: 'hover', target: { role: 'link', name: 'Help' } },
      { type: 'press_key', key: 'Enter' },
      { type: 'select_option', target: { role: 'combobox', name: 'Country' }, value: 'US' },
      { type: 'reload' },
      { type: 'go_back' },
      { type: 'assert_dom', target: { role: 'heading', name: 'Dashboard' }, contains: 'Welcome' },
      { type: 'extract', target: { role: 'textbox', name: 'Total', qaId: 'q1' }, key: 'total', pattern: '\\d+' },
      { type: 'extract', key: 'summary', prompt: 'summarize the page' },
      { type: 'assert_visual', expectation: 'no error banners', mode: 'screenshot' },
      { type: 'wait', ms: 500 },
      { type: 'upload_file', target: { role: 'button', name: 'Upload' }, paths: ['./fixtures/a.png'] },
      {
        type: 'drag_and_drop',
        source: { role: 'listitem', name: 'Card A' },
        target: { role: 'region', name: 'Done' },
      },
      { type: 'blur', target: { role: 'textbox', name: 'Notes' } },
      { type: 'mouse', kind: 'move', x: 10, y: 20 },
      { type: 'open_tab', url: 'http://localhost:3000/help' },
      { type: 'switch_tab', tabIndex: 1 },
      { type: 'close_tab', tabIndex: 1 },
      {
        type: 'script',
        steps: [
          { type: 'navigate', url: 'http://localhost:3000/checkout' },
          { type: 'type', nodeId: 'n1', text: '{{secret:CARD_NUMBER}}' },
          { type: 'click', nodeId: 'n2' },
        ],
      },
    ],
  };
}

console.log('=== v37 1/7: well-formed script (every step type) ===');
{
  const result = validateQaScript(fullScript());
  check('a well-formed script covering every step type validates', result.ok);
  if (!result.ok) console.log('  errors:', result.errors);
}

console.log('\n=== v37 2/7: unknown key rejected (.strict()) ===');
{
  const script = fullScript();
  // typo'd field on an assert_dom step — this is exactly the "typo fails
  // late and obscurely" scenario A14 calls out.
  (script.steps[8] as Record<string, unknown>).contians = 'Welcome';
  const result = validateQaScript(script);
  check('a misspelled/unknown key on a step is rejected', !result.ok);
}
{
  const script = fullScript() as Record<string, unknown>;
  script.extraTopLevelField = 'nope';
  const result = validateQaScript(script);
  check('an unknown top-level key is rejected', !result.ok);
}

console.log('\n=== v37 3/7: missing required field -> readable path-prefixed error ===');
{
  const script = fullScript();
  // click step (index 1) missing its target entirely
  script.steps[1] = { type: 'click' } as never;
  const result = validateQaScript(script);
  check('a step missing a required field is rejected', !result.ok);
  if (!result.ok) {
    const hit = result.errors.some((e) => e.startsWith('steps[1].target') && /required/i.test(e));
    check('error is path-prefixed to steps[1].target and readable', hit);
    if (!hit) console.log('  errors:', result.errors);
  }
}
{
  // nested target missing its required `role`
  const script = fullScript();
  script.steps[8] = { type: 'assert_dom', target: { name: 'Dashboard' }, contains: 'Welcome' } as never;
  const result = validateQaScript(script);
  check('a missing nested field (target.role) is rejected', !result.ok);
  if (!result.ok) {
    const hit = result.errors.some((e) => e.startsWith('steps[8].target.role'));
    check('error path descends into the nested target object', hit);
    if (!hit) console.log('  errors:', result.errors);
  }
}

console.log('\n=== v37 4/7: wrong type for a field is rejected ===');
{
  const script = fullScript();
  script.steps[12] = { type: 'wait', ms: 'five hundred' } as never; // string instead of number
  const result = validateQaScript(script);
  check('a wrong-typed field (wait.ms as string) is rejected', !result.ok);
}
{
  const script = fullScript() as Record<string, unknown>;
  script.version = 2; // only literal 1 is valid today
  const result = validateQaScript(script);
  check('a wrong version literal is rejected', !result.ok);
}

console.log('\n=== v37 5/7: nested script sub-step reuses the runner schema ===');
{
  const script = fullScript();
  const scriptStep = script.steps[script.steps.length - 1] as { type: 'script'; steps: unknown[] };
  check('fixture sanity: last step is the nested script step', scriptStep.type === 'script');
  scriptStep.steps.push({ type: 'eval', code: '1+1' }); // not an allowlisted runner verb
  const result = validateQaScript(script);
  check('an invalid sub-step inside a nested script step is rejected', !result.ok);
  if (!result.ok) {
    const hit = result.errors.some((e) => /^steps\[\d+\]\.steps\[\d+\]/.test(e));
    check('rejection is reported at the nested steps[].steps[] path', hit);
    if (!hit) console.log('  errors:', result.errors);
  }
}
{
  // dangerous-content strings (require(), eval(), etc.) are NOT this schema's
  // job — that's validateScriptSteps()'s pattern scan, re-run independently
  // at replay. Confirm this schema only checks shape, not content, so the two
  // layers don't silently duplicate/diverge.
  const script = fullScript();
  const scriptStep = script.steps[script.steps.length - 1] as { type: 'script'; steps: unknown[] };
  scriptStep.steps.push({ type: 'type', nodeId: 'n9', text: 'eval("1+1")' });
  const result = validateQaScript(script);
  check('shape-valid runner steps pass here even with dangerous text content (checked separately at replay)', result.ok);
}

console.log('\n=== v37 6/7: loadScript() end-to-end ===');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v37-scripts-'));
  const dir = path.join(root, 'generated-tests');
  fs.mkdirSync(dir, { recursive: true });

  // valid file
  const good = fullScript();
  fs.writeFileSync(path.join(dir, 'full-flow.json'), JSON.stringify(good, null, 2));
  let loadedOk = false;
  try {
    const loaded = loadScript('full-flow', root);
    loadedOk = loaded.steps.length === good.steps.length && loaded.name === 'full-flow';
  } catch (err) {
    console.log('  unexpected throw:', (err as Error).message);
  }
  check('loadScript() succeeds on a valid script file', loadedOk);

  // malformed: bad JSON syntax
  fs.writeFileSync(path.join(dir, 'broken-json.json'), '{ not valid json ');
  let badJsonThrew = false;
  let badJsonMsg = '';
  try {
    loadScript('broken-json', root);
  } catch (err) {
    badJsonThrew = true;
    badJsonMsg = (err as Error).message;
  }
  check('loadScript() throws on syntactically invalid JSON', badJsonThrew);
  check('the JSON-syntax error names the file path', badJsonMsg.includes(path.join(dir, 'broken-json.json')));

  // malformed: valid JSON, valid top-level shape, but one broken step — this
  // isolates the assertion to "the specific field problem shows up in the
  // error", rather than getting swamped by unrelated top-level omissions.
  fs.writeFileSync(
    path.join(dir, 'bad-schema.json'),
    JSON.stringify({
      version: 1,
      name: 'bad-schema',
      task: 'broken',
      url: 'http://localhost:3000/',
      sourceRunId: 'run-1',
      createdAt: new Date().toISOString(),
      steps: [{ type: 'click' }],
    }),
  );
  let badSchemaThrew = false;
  let badSchemaMsg = '';
  try {
    loadScript('bad-schema', root);
  } catch (err) {
    badSchemaThrew = true;
    badSchemaMsg = (err as Error).message;
  }
  check('loadScript() throws a clear error on a schema-invalid script', badSchemaThrew);
  check(
    'the schema error names the file path and lists specific field problems',
    badSchemaMsg.includes(path.join(dir, 'bad-schema.json')) && /steps\[0\]/.test(badSchemaMsg),
  );

  fs.rmSync(root, { recursive: true, force: true });
}

console.log('\n=== v37 7/7: round-trip with scriptFromReport() output ===');
{
  // A minimal but representative passed Report, touching enough action types
  // to exercise scriptFromReport's real emission shapes (targets with nth,
  // model-assisted extract, drag_and_drop with a resolved drop target, tab
  // primitives, a nested script action, and the synthetic finish->assert_visual).
  const report: Report = {
    runId: 'run-42',
    task: 'buy a widget',
    url: 'http://localhost:3000/',
    verdict: 'pass',
    steps: [
      { index: 0, action: { type: 'navigate', url: 'http://localhost:3000/' }, ok: true, console: [], network: [], ts: 0 },
      {
        index: 1,
        action: { type: 'click', nodeId: 'n1' },
        target: { role: 'button', name: 'Add to cart', nth: 1 },
        ok: true,
        console: [],
        network: [],
        ts: 1,
      },
      {
        index: 2,
        action: { type: 'type', nodeId: 'n2', text: 'jane@example.com' },
        target: { role: 'textbox', name: 'Email' },
        ok: true,
        console: [],
        network: [],
        ts: 2,
      },
      {
        index: 3,
        action: { type: 'extract', key: 'confirmation', prompt: 'read the confirmation banner' },
        ok: true,
        console: [],
        network: [],
        ts: 3,
      },
      {
        index: 4,
        action: {
          type: 'drag_and_drop',
          sourceId: 'n3',
          targetId: 'n4',
          sourceTarget: { role: 'listitem', name: 'Item A' },
          targetTarget: { role: 'region', name: 'Cart' },
        },
        ok: true,
        console: [],
        network: [],
        ts: 4,
      },
      { index: 5, action: { type: 'open_tab', url: 'http://localhost:3000/help' }, target: { role: 'tab', name: 'tab-1' }, ok: true, console: [], network: [], ts: 5 },
      { index: 6, action: { type: 'switch_tab', tabId: 'tab-1' }, ok: true, console: [], network: [], ts: 6 },
      { index: 7, action: { type: 'close_tab', tabId: 'tab-1' }, ok: true, console: [], network: [], ts: 7 },
      {
        index: 8,
        action: {
          type: 'script',
          steps: [
            { type: 'navigate', url: 'http://localhost:3000/checkout' },
            { type: 'click', nodeId: 'n5' },
          ],
        },
        ok: true,
        console: [],
        network: [],
        ts: 8,
      },
      { index: 9, action: { type: 'finish', verdict: 'pass' }, ok: true, console: [], network: [], ts: 9 },
    ],
  } as unknown as Report;

  const script = scriptFromReport(report);
  const result = validateQaScript(script);
  check('scriptFromReport() output validates against the schema unmodified', result.ok);
  if (!result.ok) console.log('  errors:', result.errors);
}

/* ===================== schema/type sanity ===================== */
console.log('\n=== bonus: schema export sanity ===');
{
  check('QaScriptSchema is exported and usable directly', typeof QaScriptSchema.safeParse === 'function');
  check('a bare non-object is rejected', !validateQaScript('not an object').ok);
  check('a script with a non-array steps field is rejected', !validateQaScript({ ...fullScript(), steps: 'nope' }).ok);
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v37 script-validation checks passed`);
process.exit(failed.length ? 1 : 0);
