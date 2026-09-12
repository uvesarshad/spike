/* v102 — the suggestion cards can all actually succeed (A26).
 *
 * The panel opens onto suggestion cards that START A TEST on tap, so a card
 * that cannot work is a guaranteed-fail first impression. The first one used to
 * be "Log in with the demo credentials…" — there were no demo credentials, and
 * nowhere to put any.
 *
 * Covers:
 *   1. the three default suggestions need nothing set up and suit any site
 *   2. none of them mentions credentials
 *   3. a fourth, login-shaped suggestion exists but only once a test login is
 *      saved — and hasSavedLogin(), the real function, is what decides
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

const tasks = Array.from(html.matchAll(/data-task="([^"]+)"/g)).map((m) => m[1]);

// ---- 1. the default three ---------------------------------------------------
{
  const wanted = [
    'Find anything broken on this page',
    'Check the signup form rejects a bad email',
    'Add an item to the cart and complete checkout',
  ];
  for (const t of wanted) check(`"${t}" is offered`, tasks.includes(t));
  check('"Find anything broken on this page" is offered first', tasks[0] === wanted[0]);
  check('there are four cards in all', tasks.length === 4);
}

// ---- 2. nothing that needs credentials by default --------------------------
{
  const defaults = tasks.slice(0, 3);
  const credentialish = /demo credentials|password|sign in with|log in with/i;
  for (const t of defaults) check(`"${t}" needs no credentials`, !credentialish.test(t));
  check('the old dead first card is gone', !html.includes('Log in with the demo credentials'));
}

// ---- 3. the login suggestion, gated on a saved login ------------------------
{
  check('the login suggestion exists', tasks.includes('Log in and check the dashboard loads'));
  check('...and starts hidden', /id="suggestLoginCard"[^>]*hidden/.test(html));
  check(
    '...revealed only when a login is saved',
    /function refreshLoginSuggestion\(\)[\s\S]{0,200}hidden = !hasSavedLogin\(\)/.test(panelSrc),
  );
  check('...and re-decided whenever settings come back', /refreshKeyGate\(\);[\s\S]{0,140}refreshLoginSuggestion\(\)/.test(panelSrc));

  // hasSavedLogin(), the real function, against stub configs
  function sliceFunction(src: string, name: string): string {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`function ${name} not found`);
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) return src.slice(start, i + 1);
      }
    }
    throw new Error(`unbalanced braces in ${name}`);
  }
  const has = new Function(
    'currentConfig',
    `${sliceFunction(panelSrc, 'hasSavedLogin')} return hasSavedLogin();`,
  ) as (cfg: unknown) => boolean;
  check('no config → no login suggestion', has(null) === false);
  check('half a login → no login suggestion', has({ testLogin: { user: true, password: false } }) === false);
  check('both halves → the login suggestion', has({ testLogin: { user: true, password: true } }) === true);
}

// ---- summary ---------------------------------------------------------------
const failed = checks.filter(([, ok]) => !ok);
console.log(`\nv102: ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.error(`FAILED: ${failed.map(([l]) => l).join(', ')}`);
  process.exit(1);
}
