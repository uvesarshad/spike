/* v23 — DPAPI vault key backend (#8).
 *
 * Three groups:
 *  1. DpapiKeyProvider round-trip: getKey() is stable + persists through DPAPI;
 *     the on-disk key.dpapi is NOT the raw key bytes.
 *  2. Vault driven by a DPAPI provider: set/get round-trip + secrets.enc has no
 *     plaintext.
 *  3. Provider-selection / migration rule: a pre-existing key.bin keeps
 *     FileKeyProvider (no key.dpapi); an empty dir on win32 takes the DPAPI path.
 *
 * DPAPI is Windows-only, so groups 1–2 and the win32 half of group 3 only run on
 * win32; off-Windows they're skipped (with a note) and only the key.bin-migration
 * assertions that don't need DPAPI run.
 *
 * Run: npx tsx test/v23.dpapi.ts   (exits nonzero on any failed check)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault, FileKeyProvider } from '../src/vault/vault.js';
import { DpapiKeyProvider } from '../src/vault/dpapi-key-provider.js';
import { __setShellRunner } from '../src/vault/shell-runner.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const tmp = (tag: string) => fs.mkdtempSync(path.join(os.tmpdir(), `qa-v23-${tag}-`));
const isWin = process.platform === 'win32';

/* ===================== 1) DpapiKeyProvider round-trip ===================== */
console.log('=== v23 1/3: DpapiKeyProvider round-trip + persistence ===');
if (isWin) {
  const dir = tmp('dpapi');
  const provider = new DpapiKeyProvider(dir);

  const k1 = provider.getKey();
  const k2 = provider.getKey();
  check('getKey() returns 32 bytes', k1.length === 32);
  check('getKey() twice returns identical bytes', k1.equals(k2));

  const dpapiPath = path.join(dir, 'key.dpapi');
  check('key.dpapi written to disk', fs.existsSync(dpapiPath));
  const onDisk = fs.readFileSync(dpapiPath);
  check('on-disk key.dpapi does NOT contain the raw key bytes', !onDisk.includes(k1));
  check('on-disk key.dpapi is longer than 32 bytes (DPAPI-wrapped + base64)', onDisk.length > 32);

  // A FRESH provider over the same dir must unwrap to the SAME key (true
  // persistence through DPAPI, not an in-memory cache).
  const reopened = new DpapiKeyProvider(dir);
  const k3 = reopened.getKey();
  check('fresh provider over same dir unwraps the SAME key', k1.equals(k3));
} else {
  check('constructor throws off-Windows', (() => {
    try { new DpapiKeyProvider(tmp('dpapi-non-win')); return false; }
    catch { return true; }
  })());
  console.log('  (skipping DPAPI round-trip — not win32)');
}

/* ===================== 2) Vault with the DPAPI provider ===================== */
console.log('\n=== v23 2/3: Vault over DpapiKeyProvider ===');
if (isWin) {
  const dir = tmp('vault');
  const vault = new Vault({ dir, keyProvider: new DpapiKeyProvider(dir) });
  const SECRET = 'dpapi-hunter2-secret';
  vault.set('LOGIN_PW', SECRET);
  vault.set('API_TOKEN', 'tok_xyz');

  check('get() returns the stored value', vault.get('LOGIN_PW') === SECRET);
  check('list() sorted', JSON.stringify(vault.list()) === JSON.stringify(['API_TOKEN', 'LOGIN_PW']));

  const raw = fs.readFileSync(path.join(dir, 'secrets.enc'));
  check('secrets.enc lacks the plaintext value', !raw.toString('binary').includes(SECRET));
  check('secrets.enc lacks the secret name in plaintext', !raw.toString('binary').includes('LOGIN_PW'));

  // reopen with a fresh DPAPI provider → still decrypts (end-to-end persistence)
  const reopened = new Vault({ dir, keyProvider: new DpapiKeyProvider(dir) });
  check('reopened DPAPI vault decrypts the secret', reopened.get('LOGIN_PW') === SECRET);
} else {
  console.log('  (skipping — not win32)');
}

/* ===================== 3) provider-selection / migration rule ============== */
console.log('\n=== v23 3/3: default provider selection (migration rule) ===');
{
  // (a) Pre-existing key.bin → Vault default MUST keep FileKeyProvider so legacy
  // secrets stay readable; key.dpapi must NOT be created.
  const dir = tmp('legacy');
  // seed a valid 32-byte key.bin and a secret encrypted under it (via an
  // explicit FileKeyProvider), then reopen with the DEFAULT provider.
  const keyBin = path.join(dir, 'key.bin');
  fs.writeFileSync(keyBin, crypto.randomBytes(32), { mode: 0o600 });
  const seeded = new Vault({ dir, keyProvider: new FileKeyProvider(keyBin) });
  seeded.set('LEGACY', 'legacy-value');

  const def = new Vault({ dir }); // default provider selection
  check('legacy key.bin: default vault reads the legacy secret', def.get('LEGACY') === 'legacy-value');
  def.set('NEW', 'new-value');
  check('legacy key.bin: write+read of a new secret works', def.get('NEW') === 'new-value');
  check('legacy key.bin: key.dpapi NOT created (stayed on FileKeyProvider)', !fs.existsSync(path.join(dir, 'key.dpapi')));
  check('legacy key.bin: key.bin still present', fs.existsSync(keyBin));
}

if (isWin) {
  // (b) Empty dir on win32 → default selection takes the DPAPI path: key.dpapi
  // created, no key.bin.
  const dir = tmp('fresh');
  const vault = new Vault({ dir }); // default provider selection
  vault.set('K', 'v');
  check('empty win32 dir: get() round-trips', vault.get('K') === 'v');
  check('empty win32 dir: key.dpapi created', fs.existsSync(path.join(dir, 'key.dpapi')));
  check('empty win32 dir: key.bin NOT created', !fs.existsSync(path.join(dir, 'key.bin')));
} else {
  // Off-Windows, the fresh-dir default now PREFERS the OS-native keychain
  // (macOS Keychain / Linux libsecret) when available — see src/vault/vault.ts's
  // defaultKeyProvider() and test/v68.keychain-vault.ts for that path in full.
  // This test is specifically about the FileKeyProvider FALLBACK, so it stubs
  // the shell runner to simulate "no native keychain available" (ENOENT) —
  // deterministic on every machine, and never touches this developer's real
  // OS keychain regardless of what happens to be installed here.
  const prevRunner = __setShellRunner((_file, _args, _input) => ({
    status: null,
    stdout: '',
    stderr: '',
    spawnError: new Error('ENOENT (stubbed — no native keychain in this test)'),
  }));
  try {
    const dir = tmp('fresh-non-win');
    const vault = new Vault({ dir });
    vault.set('K', 'v');
    check('empty non-win dir, no native keychain: key.bin created (FileKeyProvider fallback)', fs.existsSync(path.join(dir, 'key.bin')));
    check('empty non-win dir, no native keychain: key.dpapi NOT created', !fs.existsSync(path.join(dir, 'key.dpapi')));
  } finally {
    __setShellRunner(prevRunner);
  }
}

/* ===================== summary ===================== */
const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v23 checks passed`);
process.exit(failed.length ? 1 : 0);
