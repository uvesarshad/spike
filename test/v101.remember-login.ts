/* v101 — "Remember my login for tests" (A25).
 *
 * A storage-state file IS a session: its cookies sign whoever holds it back in.
 * It was written with the process umask (world-readable on a normal Unix box),
 * and it was reachable only from the command line — the panel could never reuse
 * a login, so every test signed in from scratch.
 *
 * Covers:
 *   1. saveStorageStateFile writes owner-only, including over an existing file
 *   2. savedLoginPath: one file per site, under ~/.spike/state, name-sanitised
 *   3. the run path loads it only when it exists and always refreshes it
 *      (the engine saves on a PASS only)
 *   4. the panel/worker wiring, gated on the desktop helper
 *   5. README documents the difference from a browser profile that stays logged in
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveStorageStateFile, loadStorageStateFile } from '../src/engine.js';
import { savedLoginPath } from '../src/vibe/service.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const serviceSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'vibe', 'service.ts'), 'utf8');
const engineSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'engine.ts'), 'utf8');
const panelSrc = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'panel.js'), 'utf8');
const panelHtml = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'panel.html'), 'utf8');
const swSrc = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'sw.js'), 'utf8');
const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');

const STATE = {
  cookies: [{ name: 'sid', value: 'secret-session', domain: 'shop.example.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const }],
  origins: [{ origin: 'https://shop.example.com', localStorage: [{ name: 'token', value: 'abc' }] }],
};

// ---- 1. the file is owner-only ---------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-v101-'));
  const file = path.join(dir, 'nested', 'state.json');
  saveStorageStateFile(file, STATE);
  check('the state file is written', fs.existsSync(file));
  check('it round-trips', loadStorageStateFile(file).cookies[0].value === 'secret-session');

  const mode = fs.statSync(file).mode & 0o777;
  if (process.platform === 'win32') {
    check('SKIP owner-only mode (no POSIX permissions on Windows)', true);
  } else {
    check(`the state file is owner-only (got ${mode.toString(8)})`, mode === 0o600);

    // re-saving must not leave a looser mode behind: writeFileSync's `mode` is
    // ignored for a file that already exists, which is exactly the case here.
    fs.chmodSync(file, 0o644);
    saveStorageStateFile(file, STATE);
    check('re-saving tightens an existing, looser file', (fs.statSync(file).mode & 0o777) === 0o600);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- 2. one file per site ---------------------------------------------------
{
  const p = savedLoginPath('shop.example.com');
  check('the saved login lives under the home directory', p.startsWith(os.homedir()));
  check('...in .spike/state', p.includes(path.join('.spike', 'state')));
  check('...named after the site', path.basename(p) === 'shop.example.com.json');
  check('two sites never share a file', savedLoginPath('a.example.com') !== savedLoginPath('b.example.com'));
  check('a port does not produce an illegal filename', !path.basename(savedLoginPath('localhost:9401')).includes(':'));
  check('nothing from a URL can steer the path', !savedLoginPath('../../etc/passwd').includes('..'));
  check('an empty host still yields a file', path.basename(savedLoginPath('')) === 'site.json');
}

// ---- 3. how a run uses it ---------------------------------------------------
{
  check('a run only opts in when the user asked', /const rememberLogin = Boolean\(\(params as \{ rememberLogin\?: unknown \}\)\.rememberLogin\);/.test(serviceSrc));
  check('an existing saved login is loaded', /haveSavedLogin && \{ storageStatePath: loginStatePath \}/.test(serviceSrc));
  check('...and the file is always refreshed', /loginStatePath && \{ saveStorageStatePath: loginStatePath \}/.test(serviceSrc));
  check(
    'a failed run never overwrites a good saved login',
    /report\.verdict === 'pass' && opts\.saveStorageStatePath/.test(engineSrc),
  );
  check('the user is told which of the two happened', serviceSrc.includes('Using the sign-in remembered for this site.'));
}

// ---- 4. the panel wiring ----------------------------------------------------
{
  check('there is a checkbox', panelHtml.includes('id="rememberLogin"'));
  check('it is worded as agreed', panelHtml.includes('Remember my login for tests'));
  check('it starts hidden', /id="rememberLoginRow"[^>]*hidden/.test(panelHtml));
  check('it is offered only with the desktop helper', /rememberLoginRow\.hidden = !bridgeHealthy\(\)/.test(panelSrc));
  check('the run carries the choice', /runMsg\.rememberLogin = true/.test(panelSrc));
  check('...only with a helper to hold it', /rememberLogin\.checked && bridgeHealthy\(\)/.test(panelSrc));
  check('the worker forwards it', /runParams\.rememberLogin = true/.test(swSrc));
  check('the choice is remembered between panels', panelSrc.includes("const REMEMBER_LOGIN_KEY = 'spikeRememberLogin'"));
  check('no user-facing copy says "storage state"', !/consent-text[\s\S]{0,300}storage state/i.test(panelHtml));
}

// ---- 5. the README is honest about the tradeoff ----------------------------
{
  check('README documents the saved session in the panel', readme.includes('Remember my login for tests'));
  check('...names the file it writes', readme.includes('~/.spike/state/<host>.json'));
  check('...explains the persistent-profile alternative', /persistent Chrome profile/.test(readme));
  check('...says a fresh context needs it', /fresh context/.test(readme));
  check('...warns the file is a live session', /anyone who can read it is signed in as you/.test(readme));
}

// ---- summary ---------------------------------------------------------------
const failed = checks.filter(([, ok]) => !ok);
console.log(`\nv101: ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.error(`FAILED: ${failed.map(([l]) => l).join(', ')}`);
  process.exit(1);
}
