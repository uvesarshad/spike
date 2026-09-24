/* v161 — E6: `spike login` flow with a stubbed browser (no Chrome, no stdin). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultSessionPath, LoginError, runLogin, type LoginBrowser } from '../src/login/login.js';
import { loadStorageStateFile, saveStorageStateFile, type StorageState } from '../src/engine.js';

let bad = 0;
const check = (label: string, ok: boolean) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); };

const state: StorageState = {
  cookies: [{ name: 's', value: 'v', domain: 'x.test', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }],
  origins: [{ origin: 'https://x.test', localStorage: [{ name: 't', value: '1' }] }],
};
const stub = (s: StorageState, log: string[]): LoginBrowser => ({
  open: async (u) => { log.push(`open ${u}`); },
  capture: async () => { log.push('capture'); return s; },
  close: async () => { log.push('close'); },
});

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-login-'));
  const file = defaultSessionPath('https://app.x.test:8443/login', home);
  check('default path is per site under the home dir', file === path.join(home, '.spike', 'sessions', 'app.x.test_8443.json'));

  const log: string[] = [];
  const order: string[] = [];
  const r = await runLogin('https://x.test/login', file, {
    browser: stub(state, log),
    waitForDone: async () => { order.push('done'); log.push('waited'); },
    progress: (l) => order.push(l),
  });
  check('open, wait, capture, close in order', log.join('|') === 'open https://x.test/login|waited|capture|close');
  check('reports counts', r.cookies === 1 && r.sites === 1 && r.file === file);
  const back = loadStorageStateFile(file);
  check('saved file loads back as the same session', back.cookies[0].name === 's');
  check('saved owner-only', process.platform === 'win32' || (fs.statSync(file).mode & 0o077) === 0);

  const log2: string[] = [];
  let saved = false;
  let err: unknown;
  try {
    await runLogin('https://x.test', file, { browser: stub({ cookies: [], origins: [] }, log2), waitForDone: async () => {}, save: () => { saved = true; } });
  } catch (e) { err = e; }
  check('empty session is refused, not saved, window still closed', err instanceof LoginError && !saved && log2.includes('close'));

  let bad2: unknown;
  try { await runLogin('nope', file, { browser: stub(state, []), waitForDone: async () => {} }); } catch (e) { bad2 = e; }
  check('bad address refused', bad2 instanceof LoginError);

  const log3: string[] = [];
  try {
    await runLogin('https://x.test', file, { browser: stub(state, log3), waitForDone: async () => { throw new Error('interrupted'); } });
  } catch { /* expected */ }
  check('window closed even if waiting fails', log3.includes('close'));

  void saveStorageStateFile;
  process.exit(bad ? 1 : 0);
})();
