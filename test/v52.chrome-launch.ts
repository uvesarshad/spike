/* V52 - chrome/launch.ts: SPIKE_CHROME_PATH override (A10) and profile-lock
 * detection (A29). Pure fs/env unit coverage — no Chrome, no CDP, no bound
 * network sockets, no ports. Safe for the fast bucket.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectProfileLock, findChrome } from '../src/chrome/launch.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-v52-'));
const savedEnv = process.env.SPIKE_CHROME_PATH;

function withEnv(value: string | undefined, fn: () => void) {
  if (value === undefined) delete process.env.SPIKE_CHROME_PATH;
  else process.env.SPIKE_CHROME_PATH = value;
  try {
    fn();
  } finally {
    if (savedEnv === undefined) delete process.env.SPIKE_CHROME_PATH;
    else process.env.SPIKE_CHROME_PATH = savedEnv;
  }
}

// --- A10: SPIKE_CHROME_PATH override -------------------------------------

// A real file stands in for a Chrome executable — findChrome() only checks
// existence, it doesn't try to run the binary.
const realChromeStandIn = path.join(tmpRoot, 'fake-chrome-binary');
fs.writeFileSync(realChromeStandIn, '');

withEnv(realChromeStandIn, () => {
  const resolved = findChrome();
  check('SPIKE_CHROME_PATH set to a real file is chosen first', resolved === realChromeStandIn);
});

const fakePath = path.join(tmpRoot, 'does-not-exist-chrome');
withEnv(fakePath, () => {
  let threw: unknown;
  try {
    findChrome();
  } catch (err) {
    threw = err;
  }
  const msg = threw instanceof Error ? threw.message : '';
  check('SPIKE_CHROME_PATH set to a fake path throws', threw instanceof Error);
  check('the error clearly names SPIKE_CHROME_PATH', msg.includes('SPIKE_CHROME_PATH'));
  check('the error includes the offending path', msg.includes(fakePath));
});

// A config-threaded chromePath override (the LaunchOptions.chromePath /
// QaConfig.chromePath path) behaves the same as the env var when the env
// var itself is unset — and the env var still wins when both are set.
withEnv(undefined, () => {
  const resolved = findChrome(realChromeStandIn);
  check('chromePath param is used when SPIKE_CHROME_PATH is unset', resolved === realChromeStandIn);
});
withEnv(realChromeStandIn, () => {
  const otherRealFile = path.join(tmpRoot, 'other-fake-chrome-binary');
  fs.writeFileSync(otherRealFile, '');
  const resolved = findChrome(otherRealFile);
  check('SPIKE_CHROME_PATH env wins over a chromePath param', resolved === realChromeStandIn);
});

// --- A29: profile-lock detection ------------------------------------------

// No profile dir at all → no lock, no throw.
const missingProfileDir = path.join(tmpRoot, 'no-such-profile');
check('missing profile dir reports no lock', detectProfileLock(missingProfileDir) === null);

// An existing but empty profile dir → no lock.
const emptyProfileDir = path.join(tmpRoot, 'empty-profile');
fs.mkdirSync(emptyProfileDir);
check('profile dir with no lock files reports no lock', detectProfileLock(emptyProfileDir) === null);

if (process.platform !== 'win32') {
  // Stale lock: SingletonLock points at a pid that isn't running. Use a pid
  // far outside any plausible live range plus a defensive isPidAlive-style
  // probe isn't available here, so pick a huge pid unlikely to exist.
  const staleProfileDir = path.join(tmpRoot, 'stale-lock-profile');
  fs.mkdirSync(staleProfileDir);
  const deadPid = 999999; // implausibly high; kill(deadPid, 0) should ESRCH on any dev machine
  fs.symlinkSync(`${os.hostname()}-${deadPid}`, path.join(staleProfileDir, 'SingletonLock'));
  check('stale lock (dead pid) reports no lock', detectProfileLock(staleProfileDir) === null);

  // Live lock: SingletonLock points at our OWN pid, which is definitely alive.
  const liveProfileDir = path.join(tmpRoot, 'live-lock-profile');
  fs.mkdirSync(liveProfileDir);
  const livePid = process.pid;
  fs.symlinkSync(`${os.hostname()}-${livePid}`, path.join(liveProfileDir, 'SingletonLock'));
  const lock = detectProfileLock(liveProfileDir);
  check('live lock (our own pid) reports a lock', lock !== null && lock.pid === livePid);
} else {
  console.log('SKIP  POSIX SingletonLock checks (win32 host)');
}

const failed = checks.filter(([, ok]) => !ok);
fs.rmSync(tmpRoot, { recursive: true, force: true });
if (failed.length) {
  console.error(`\n${failed.length} checks failed:`);
  for (const [label] of failed) console.error(` - ${label}`);
  process.exit(1);
}

console.log(`\nV52 chrome-launch checks passed (${checks.length}).`);
