/* v74 — the first-run "no AI key yet" gate (A4).
 *
 * Before this, the side panel opened onto three suggestion cards that each
 * started a run immediately; with no key stored the run failed seconds later
 * with a message full of internal role names, shown in a dead red banner.
 *
 * The panel and the service worker are MV3 sources that can't be imported here
 * (they need chrome.* and a DOM), so this suite does what v34 does for the
 * storage migration: it reads the SHIPPED source and, where the logic is pure,
 * slices the real function out and runs it against stubs. String assertions
 * cover the parts that are only reachable through the DOM.
 *
 * Covers:
 *   1. extension/sw.js refuses a keyless run in plain English, tagged
 *      code:'no-key' so the panel can attach an "Open Settings" action
 *   2. the old role-jargon refusals are gone
 *   3. panel.js's missingAiKey() — the real function, against stub configs
 *   4. startRun refuses BEFORE it posts a run; the banner carries the action
 *   5. extension/*.js are clean text (a stray control byte ships to Chrome)
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
const swSrc = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'sw.js'), 'utf8');
const panelSrc = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'panel.js'), 'utf8');

// ---- 1. the refusal the user actually reads --------------------------------
{
  const PLAIN = 'No AI key saved yet. Open Settings and paste a key from Anthropic, Google or OpenAI.';
  check('sw.js carries the plain-English no-key sentence', swSrc.includes(PLAIN));
  const tagged = swSrc.match(/kind: 'error', code: 'no-key'/g) || [];
  check('both keyless refusals are tagged code:no-key', tagged.length === 2);
}

// ---- 2. no internal role names in that path --------------------------------
{
  const jargon = ['Brain (planner) API key', 'Navigator API key', 'lite mode is BYOK'];
  for (const s of jargon) {
    check(`sw.js no longer says "${s}"`, !swSrc.includes(s));
  }
}

// ---- 3. missingAiKey(), the real function ----------------------------------
/** Slice one top-level `function name(...) { ... }` out of a source file by
 * brace matching, so the test runs shipped code rather than a copy. */
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

type Provider = { id: string; needsKey: boolean; hasKey: boolean };
type Cfg = {
  providers: Provider[];
  navigator?: { provider: string; mode?: string };
  planner?: { provider: string; mode?: string };
};

const missingAiKeySrc = sliceFunction(panelSrc, 'missingAiKey');
const providerInfoSrc = sliceFunction(panelSrc, 'providerInfo');

/** Run the sliced panel functions against a stub config / helper-app state. */
function missingAiKey(currentConfig: Cfg | null, bridgeIsHealthy: boolean): boolean {
  const factory = new Function(
    'currentConfig',
    'bridgeHealthy',
    `${providerInfoSrc}\n${missingAiKeySrc}\nreturn missingAiKey();`,
  ) as (c: Cfg | null, h: () => boolean) => boolean;
  return factory(currentConfig, () => bridgeIsHealthy);
}

const KEYED = { id: 'claude', needsKey: true, hasKey: true };
const UNKEYED = { id: 'gemini', needsKey: true, hasKey: false };
const ONDEVICE = { id: 'nano', needsKey: false, hasKey: false };

{
  check('unknown settings are never treated as missing a key', missingAiKey(null, false) === false);

  check(
    'the model that clicks has no key → gated',
    missingAiKey(
      { providers: [UNKEYED, KEYED], navigator: { provider: 'gemini', mode: 'api' }, planner: { provider: 'claude', mode: 'api' } },
      false,
    ) === true,
  );

  check(
    'the model that plans has no key → gated too (the run refuses on either)',
    missingAiKey(
      { providers: [UNKEYED, KEYED], navigator: { provider: 'claude', mode: 'api' }, planner: { provider: 'gemini', mode: 'api' } },
      false,
    ) === true,
  );

  check(
    'both keys stored → not gated',
    missingAiKey(
      { providers: [KEYED], navigator: { provider: 'claude', mode: 'api' }, planner: { provider: 'claude', mode: 'api' } },
      false,
    ) === false,
  );

  check(
    'the on-device model needs no key',
    missingAiKey(
      { providers: [ONDEVICE, KEYED], navigator: { provider: 'nano', mode: 'ondevice' }, planner: { provider: 'claude', mode: 'api' } },
      false,
    ) === false,
  );

  const cliCfg: Cfg = {
    providers: [UNKEYED, { id: 'claude', needsKey: true, hasKey: false }],
    navigator: { provider: 'claude', mode: 'cli' },
    planner: { provider: 'claude', mode: 'cli' },
  };
  check('a command-line model with the desktop helper running needs no key', missingAiKey(cliCfg, true) === false);
  check('the same model without the helper does need one', missingAiKey(cliCfg, false) === true);
}

// ---- 4. the gate sits in front of the run, and the banner leads somewhere ---
{
  const startRun = sliceFunction(panelSrc, 'startRun');
  const gateAt = startRun.indexOf('missingAiKey()');
  const postAt = startRun.indexOf('postToSW(runMsg)');
  check('startRun checks for a key', gateAt > 0);
  check('...before it ever posts the run', gateAt > 0 && postAt > gateAt);

  check("the no-key banner offers 'Open Settings'", panelSrc.includes("label: 'Open Settings'"));
  check('...which opens straight onto the key field', panelSrc.includes('openSettings({ focusKey: true })'));
  check("the worker's no-key error is rendered with that action", panelSrc.includes("msg.code === 'no-key'"));

  // A4 (first bullet): the primary Save stores a typed key before the settings
  const save = panelSrc.indexOf("settingsSave.addEventListener('click'");
  const saveKeyAt = panelSrc.indexOf('saveKeyFromCard(navCardRefs)', save);
  const configSetAt = panelSrc.indexOf("kind: 'config-set'", save);
  check('the primary Save stores the typed key before the settings go out', save > 0 && saveKeyAt > save && configSetAt > saveKeyAt);
  check('leaving either key field saves it', /setKey\.addEventListener\('blur'/.test(panelSrc) && /setNavKey\.addEventListener\('blur'/.test(panelSrc));
}

// ---- 5. the shipped sources are clean text ---------------------------------
{
  // a stray NUL or other control byte survives an editor round-trip and only
  // shows up as a mangled panel in the browser
  // eslint-disable-next-line no-control-regex
  const control = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
  for (const f of ['panel.js', 'sw.js']) {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'extension', f), 'utf8');
    check(`extension/${f} has no stray control characters`, !control.test(src));
  }
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v74 checks passed`);
process.exit(failed.length ? 1 : 0);
