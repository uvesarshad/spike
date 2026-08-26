/* V59 - A36 (P1): SPIKE_NO_SYSTEM_CA opt-out for the baked-in
 * `NODE_OPTIONS=--use-system-ca` TLS workaround.
 *
 * defaultGoogleCliEnv() (src/config.ts) reads process.env directly on every
 * call — it's only invoked once to seed DEFAULTS.googleCliEnv at module load,
 * but the function itself has no import-time caching, so it can be exercised
 * directly here with different env states instead of needing a subprocess
 * per case. Pure env-var unit coverage — no Chrome, no network, no ports.
 * Safe for the fast bucket.
 */

import assert from 'node:assert/strict';
import { defaultGoogleCliEnv } from '../src/config.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const saved = process.env.SPIKE_NO_SYSTEM_CA;
function withEnv(value: string | undefined, fn: () => void) {
  if (value === undefined) delete process.env.SPIKE_NO_SYSTEM_CA;
  else process.env.SPIKE_NO_SYSTEM_CA = value;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env.SPIKE_NO_SYSTEM_CA;
    else process.env.SPIKE_NO_SYSTEM_CA = saved;
  }
}

withEnv(undefined, () => {
  const env = defaultGoogleCliEnv();
  check('SPIKE_NO_SYSTEM_CA unset keeps the --use-system-ca flag', env.NODE_OPTIONS === '--use-system-ca');
});

withEnv('1', () => {
  const env = defaultGoogleCliEnv();
  check('SPIKE_NO_SYSTEM_CA=1 omits NODE_OPTIONS entirely', env.NODE_OPTIONS === undefined);
  check('SPIKE_NO_SYSTEM_CA=1 returns an empty env object', Object.keys(env).length === 0);
});

withEnv('true', () => {
  const env = defaultGoogleCliEnv();
  check("SPIKE_NO_SYSTEM_CA='true' also omits NODE_OPTIONS", env.NODE_OPTIONS === undefined);
});

withEnv('0', () => {
  const env = defaultGoogleCliEnv();
  check("SPIKE_NO_SYSTEM_CA='0' (not '1'/'true') keeps the flag", env.NODE_OPTIONS === '--use-system-ca');
});

// Sanity: assert module didn't silently no-op above (would show as 0 checks).
assert.ok(checks.length >= 5, 'expected at least 5 checks to have run');

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  console.error(`\n${failed.length} checks failed:`);
  for (const [label] of failed) console.error(` - ${label}`);
  process.exit(1);
}

console.log(`\nV59 no-system-ca checks passed (${checks.length}).`);
