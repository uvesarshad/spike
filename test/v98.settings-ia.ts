/* v98 — Settings information architecture (A18).
 *
 * The safety and cost switches used to sit in a collapsed accordion called
 * "Debugging", written in engine vocabulary, next to model choices the
 * browser-only path cannot run at all. This suite pins the fixed shape.
 *
 * panel.html/panel.js are MV3 sources that need a DOM and chrome.*, so — as in
 * v74 — string assertions cover what is only reachable through the DOM, and the
 * pure helpers are sliced out of the SHIPPED source and run against stubs.
 *
 * Covers:
 *   1. the accordion is "Safety & cost"; the spend cap is on the main screen
 *   2. the four toggle subtitles are in user vocabulary, jargon gone
 *   3. offerOnlyRunnableChoices() hides what the no-helper path can't run
 *   4. the "Same as Navigator" note resolves the PLANNING role's model
 *   5. the browser-only progress lines carry no internal vocabulary
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const html = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'panel.html'), 'utf8');
const panelSrc = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'panel.js'), 'utf8');
const liteSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'extension', 'lite-engine.ts'), 'utf8');

// ---- 1. accordion title + spend cap placement ------------------------------
{
  check('the accordion is titled "Safety & cost"', html.includes('Safety &amp; cost'));
  check('no "Debugging" accordion title remains', !/settings-acc-title">Debugging</.test(html));

  // the spend cap input must sit in the main body, next to the consent switch —
  // i.e. BEFORE the settings modal closes is wrong; it must come after it.
  const capAt = html.indexOf('id="setSpendCap"');
  const consentAt = html.indexOf('id="consentToggle"');
  const runBtnAt = html.indexOf('id="runBtn"');
  check('the spend cap input still exists', capAt > 0);
  check('the spend cap sits between the consent switch and the Run button', consentAt < capAt && capAt < runBtnAt);
  check('the spend cap persists itself on change', /setSpendCap\.addEventListener\('change'/.test(panelSrc));
}

// ---- 2. the four subtitles, in user words ----------------------------------
{
  check(
    'strict checks use the agreed sentence',
    html.includes('a real error on the page always counts as a fail, even if the AI thinks it passed'),
  );
  const banned = [
    'strict oracle mode',
    'metamorphic-relation mismatch',
    'Deterministic verdicts',
    '$0-first',
    'Video assertions',
    'paid vision model',
  ];
  for (const s of banned) check(`panel.html no longer says "${s}"`, !html.includes(s));
  check('auto-fix names the helper in full', html.includes('Spike Core, the optional desktop helper'));
  check('the spend cap sub is plain English', html.includes("It's an estimate, not your exact bill."));
}

// ---- 3. provider/mode filtering when there is no desktop helper ------------
/** Slice one top-level `function name(...) { ... }` out of a source file. */
function sliceFunction(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

type Opt = { value: string; hidden: boolean; disabled: boolean };
function runFilter(helper: boolean, selected: string) {
  const options: Opt[] = [
    { value: 'nano', hidden: false, disabled: false },
    { value: 'gemini', hidden: false, disabled: false },
    { value: 'claude', hidden: false, disabled: false },
    { value: 'ollama', hidden: false, disabled: false },
  ];
  const providers = [
    { id: 'nano', liteUsable: false },
    { id: 'gemini', liteUsable: true },
    { id: 'claude', liteUsable: true },
    { id: 'ollama', liteUsable: false },
  ];
  const provider = {
    value: selected,
    options,
    querySelectorAll: () => ({ forEach: (fn: (o: Opt) => void) => options.forEach(fn) }),
  };
  const fn = new Function(
    'bridgeHealthy',
    'providerInfo',
    `${sliceFunction(panelSrc, 'offerOnlyRunnableChoices')}; return offerOnlyRunnableChoices;`,
  )(
    () => helper,
    (id: string) => providers.find((p) => p.id === id) || null,
  );
  fn({ provider });
  return { options, selected: provider.value };
}

{
  const off = runFilter(false, 'gemini');
  const byId = (id: string) => off.options.find((o) => o.value === id)!;
  check('no helper: the local-model-server option is hidden', byId('ollama').hidden && byId('ollama').disabled);
  check('no helper: on-device AI is still offered', !byId('nano').hidden);
  check('no helper: key-based providers are still offered', !byId('gemini').hidden && !byId('claude').hidden);

  const moved = runFilter(false, 'ollama');
  check('no helper: a saved unrunnable pin moves to a runnable one', moved.selected !== 'ollama');

  const on = runFilter(true, 'gemini');
  check('with a helper: every option stays available', on.options.every((o) => !o.hidden));

  check(
    'the command-line radio needs a helper',
    /const hasCli = modes\.includes\('cli'\) && helper;/.test(panelSrc),
  );
}

// ---- 4. the "Same as Navigator" note names the model that will PLAN --------
{
  const note = sliceFunction(panelSrc, 'refreshSameAsNav');
  check(
    'the shared-setup note resolves the planning role, not the clicking one',
    note.includes("defaultModelFor(info, selectedNavMode(), 'brain')"),
  );
  check('...and no longer resolves it as the navigator', !note.includes("selectedNavMode(), 'navigator')"));
}

// ---- 5. progress lines the user reads during a browser-only run -----------
{
  const progressLines = Array.from(liteSrc.matchAll(/progress\(\s*([\s\S]*?)\);/g)).map((m) => m[1]);
  check('the browser-only engine still reports progress', progressLines.length >= 5);
  const banned = ['rung 0', 'BYOK', 'lite mode', 'no daemon', 'artifacts.runId', 'navigator:', 'brain:', 'verdict:'];
  for (const s of banned) {
    check(`no progress line says "${s}"`, !progressLines.some((l) => l.includes(s)));
  }
  check('the run start line is plain', liteSrc.includes('progress(`Testing "${opts.task}" on ${opts.url}`)'));
}

// ---- summary ---------------------------------------------------------------
const failed = checks.filter(([, ok]) => !ok);
console.log(`\nv98: ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.error(`FAILED: ${failed.map(([l]) => l).join(', ')}`);
  process.exit(1);
}
