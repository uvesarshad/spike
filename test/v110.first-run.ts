/* v110 — E1: the three-step first run.
 *
 * A brand-new user used to land on the whole panel with a banner pointing at a
 * Settings screen that asked for TWO separate keys before the first test could
 * run. This suite pins the replacement: one key, the tab that will be tested,
 * one switch — and everything granular still there, one tap away.
 *
 * panel.html/panel.js are MV3 sources that need a DOM and chrome.*, so (as in
 * v98) string assertions cover what is only reachable through the DOM, and the
 * pure helpers are sliced out of the SHIPPED source and run against stubs.
 *
 * Covers:
 *   1. the key's own opening characters say which provider it is
 *   2. the screen is three steps, asks for exactly ONE key, and shows the tab
 *      plus the one consent switch the rest of the panel already uses
 *   3. it only appears when nothing at all is stored, and collapses into the
 *      normal panel once a key is saved
 *   4. that one key is pointed at BOTH jobs
 *   5. nothing granular was deleted — it is reachable behind "Advanced"
 *   6. every word on it is user vocabulary
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
const css = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'panel.css'), 'utf8');

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

/** The first-run markup on its own, so "only one key field" can be asserted
 * about THIS screen rather than about the whole panel. */
function firstRunMarkup(): string {
  const start = html.indexOf('<section id="firstRun"');
  const end = html.indexOf('</section>', start);
  if (start < 0 || end < 0) throw new Error('the first-run section is missing from panel.html');
  return html.slice(start, end);
}

// ---- 1. the key says which provider it is ----------------------------------
console.log('=== v110 1/6: the key identifies itself ===');
{
  const providerFromKey = new Function(`${sliceFunction(panelSrc, 'providerFromKey')}; return providerFromKey;`)() as (k: unknown) => string;

  check('an Anthropic key is recognised', providerFromKey('sk-ant-api03-abc123') === 'claude');
  check('a Google key is recognised', providerFromKey('AIzaSyA-not-a-real-key') === 'gemini');
  check('an OpenAI key is recognised', providerFromKey('sk-proj-abc123') === 'gpt');
  check('the Anthropic prefix wins over the plain sk- one', providerFromKey('sk-ant-xyz') !== 'gpt');
  check('surrounding spaces from a paste are ignored', providerFromKey('  sk-ant-abc  ') === 'claude');
  check('nothing typed means nothing guessed', providerFromKey('') === '' && providerFromKey(null) === '');
  check('an unfamiliar key is not guessed at', providerFromKey('glm-whatever-1234') === '');
}

// ---- 2. three steps, one key, the tab, one switch --------------------------
console.log('\n=== v110 2/6: the shape of the screen ===');
{
  const section = firstRunMarkup();

  const stepCount = (section.match(/class="first-run-step"/g) || []).length;
  check('it is exactly three steps', stepCount === 3);

  const keyInputs = (section.match(/<input[^>]*type="password"/g) || []).length;
  check('it asks for exactly one key', keyInputs === 1);
  check('the key field is there with a Save next to it', section.includes('id="firstRunKey"') && section.includes('id="firstRunKeySave"'));
  check(
    'the key field hints at all three shapes',
    section.includes('sk-ant-') && section.includes('AIza') && /placeholder="[^"]*sk-…/.test(section),
  );

  check('step 2 shows the tab that will be tested', section.includes('id="firstRunTabTitle"') && section.includes('id="firstRunTabHost"'));
  check('and says the test runs as the signed-in user', section.includes("I'll test this page logged in as you"));

  check('step 3 is the click-and-type switch', section.includes('id="firstRunConsent"'));
  check(
    'worded exactly as the switch on the normal screen',
    section.includes('Allow the agent to click &amp; type on this site') && section.includes('Off = look-only mode'),
  );
  check('the switch is a mirror of the one switch, never a second setting', /consentToggle\.checked = firstRunConsent\.checked/.test(panelSrc));

  check('the screen has styling of its own', css.includes('.first-run-step') && css.includes('.first-run-num'));
}

// ---- 3. when it appears, and when it gets out of the way -------------------
console.log('\n=== v110 3/6: it appears once and then never again ===');
{
  const make = (config: unknown) =>
    new Function('currentConfig', `${sliceFunction(panelSrc, 'noKeyStoredAnywhere')}; return noKeyStoredAnywhere();`)(config) as boolean;

  check('nothing stored → the screen is for this', make({ providers: [{ id: 'claude', hasKey: false }, { id: 'gemini', hasKey: false }] }) === true);
  check('one key stored → the normal panel', make({ providers: [{ id: 'claude', hasKey: true }, { id: 'gemini', hasKey: false }] }) === false);
  check('settings not fetched yet → never shown on a guess', make(null) === false && make({}) === false);

  const refresh = sliceFunction(panelSrc, 'refreshFirstRun');
  check('it also needs a key to actually be what is missing', /noKeyStoredAnywhere\(\) && missingAiKey\(\)/.test(refresh));
  check('showing it hides the normal screen, and vice versa', /inputsSection\.hidden = show/.test(refresh));
  check('the normal screen is the one that can be hidden', html.includes('id="inputsSection"'));

  const gate = sliceFunction(panelSrc, 'refreshKeyGate');
  check('the old "add a key" banner never doubles up on it', /firstRunVisible\(\)/.test(gate));
}

// ---- 4. one key covers both jobs -------------------------------------------
console.log('\n=== v110 4/6: one key, both jobs ===');
{
  const saved = sliceFunction(panelSrc, 'onFirstRunKeySaved');
  check('the saved key is applied to both jobs at once', /planner: \{ \.\.\.role \}, navigator: \{ \.\.\.role \}/.test(saved));
  check('the provider is the detected one, not a guess', /provider: msg\.provider/.test(saved));
  check(
    'the model is left blank so each job gets its own sensible one',
    /model: ''/.test(saved),
  );
  check('a key that would not save says so instead of pretending', /I could not save that key/.test(saved));
}

// ---- 5. nothing granular was removed ---------------------------------------
console.log('\n=== v110 5/6: the granular controls are all still there ===');
{
  const section = firstRunMarkup();
  check('there is a way to the full settings from the screen', section.includes('id="firstRunAdvanced"'));
  check('and it opens the settings screen', /firstRunAdvanced\.addEventListener\('click', \(\) => openSettings/.test(panelSrc));
  check('both per-job cards still exist', html.includes('id="setNavProvider"') && html.includes('id="setProvider"'));
  check('so does a key field for each of them', html.includes('id="setNavKey"') && html.includes('id="setKey"'));
  check('a second key is never asked for on the first screen', !section.includes('id="setNavKey"') && !section.includes('id="setKey"'));
}

// ---- 6. the words on it ----------------------------------------------------
console.log('\n=== v110 6/6: user vocabulary only ===');
{
  const section = firstRunMarkup();
  const banned = [
    'daemon', 'CDP', 'bridge', 'BYOK', 'lite mode', 'navigator', 'brain',
    'planner', 'oracle', 'metamorphic', 'invariant', 'rung', 'a11y',
    'allowedHosts', 'SPIKE_', 'provider',
  ];
  const hits = banned.filter((w) => new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(section));
  check(`no internal vocabulary on the screen${hits.length ? ` (found: ${hits.join(', ')})` : ''}`, hits.length === 0);
  check('the jobs are described by what they do', /model for each job/i.test(section));
}

/* ---------------------------------------------------------------------- */
const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  for (const [label] of failed) console.error(`FAILED: ${label}`);
  process.exit(1);
}
