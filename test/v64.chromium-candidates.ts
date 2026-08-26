/* V64 - "Chromium support" enhancement (docs/plan/26-08-27-audit-market-
 * readiness.md Suggested Enhancements, after A10): chrome/launch.ts's
 * candidate list now falls back to common Chromium install paths BEHIND the
 * branded-Chrome candidates, and isChromiumPath() flags a resolved path as
 * Chromium (vs branded Chrome) for the Nano "unavailable" hint. Pure
 * fs/array unit coverage — no Chrome, no CDP, no bound network sockets, no
 * ports. Safe for the fast bucket. Follows test/v52.chrome-launch.ts's
 * style.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromeCandidates, isChromiumPath, pickFirstExisting } from '../src/chrome/launch.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

// --- candidate-list ordering (no filesystem involved) ---------------------

const candidates = chromeCandidates();
const chromiumPaths = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

for (const p of chromiumPaths) {
  check(`candidate list includes ${p}`, candidates.includes(p));
}

const lastChromeIdx = Math.max(
  ...candidates
    .map((p, i) => [p, i] as const)
    .filter(([p]) => !isChromiumPath(p))
    .map(([, i]) => i),
);
const firstChromiumIdx = Math.min(...chromiumPaths.map((p) => candidates.indexOf(p)));
check(
  'every Chromium candidate sits behind every Chrome candidate',
  firstChromiumIdx > lastChromeIdx,
);

// --- isChromiumPath() ------------------------------------------------------

check('isChromiumPath: true for a chromium path', isChromiumPath('/usr/bin/chromium'));
check('isChromiumPath: true for the snap path', isChromiumPath('/snap/bin/chromium'));
check(
  'isChromiumPath: true for Chromium.app (case-insensitive)',
  isChromiumPath('/Applications/Chromium.app/Contents/MacOS/Chromium'),
);
check('isChromiumPath: false for branded Chrome', !isChromiumPath('/usr/bin/google-chrome'));
check(
  'isChromiumPath: false for branded Chrome.app',
  !isChromiumPath('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
);

// --- pickFirstExisting(): Chrome wins when both exist; Chromium picked when
// only Chromium exists -----------------------------------------------------

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-v64-'));
const chromeStandIn = path.join(tmpRoot, 'google-chrome');
const chromiumStandIn = path.join(tmpRoot, 'chromium');
fs.writeFileSync(chromeStandIn, '');
fs.writeFileSync(chromiumStandIn, '');

// Priority order matters: Chrome candidate listed first, as in the real list.
check(
  'Chrome wins when both Chrome and Chromium exist',
  pickFirstExisting([chromeStandIn, chromiumStandIn]) === chromeStandIn,
);

const missingChrome = path.join(tmpRoot, 'does-not-exist-chrome');
check(
  'Chromium is picked when only Chromium exists',
  pickFirstExisting([missingChrome, chromiumStandIn]) === chromiumStandIn,
);

check('pickFirstExisting returns undefined when nothing exists', pickFirstExisting([missingChrome]) === undefined);

fs.rmSync(tmpRoot, { recursive: true, force: true });

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  console.error(`\n${failed.length} checks failed:`);
  for (const [label] of failed) console.error(` - ${label}`);
  process.exit(1);
}

console.log(`\nV64 chromium-candidates checks passed (${checks.length}).`);
