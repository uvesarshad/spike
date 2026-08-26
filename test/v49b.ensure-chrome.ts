/* v49b — A3 (P0) / A31 (P1): ensureChrome() concurrency dedupe, REAL Chrome.
 *
 * Split out of test/v49.parallel-session.ts (A31, 2026-08-27): this is the
 * one check from that suite's original scope that needs a REAL Chrome — N
 * concurrent callers on a COLD port must not race two `spawn()`s / throw,
 * the exact hazard docs/plan/26-08-08-audit-deterministic-speed.md's A3
 * calls out. Splitting it here keeps v49 itself (and the rest of the fast
 * bucket) genuinely Chrome-free, so `npm test` passes on a machine with no
 * Chrome installed at all — this suite lives in scripts/run-tests.mjs's
 * BROWSER_SUITES list instead, run serially via `npm run test:browser`.
 *
 * Run on a freshly `allocateFreePort()`-ed CDP port + a throwaway temp
 * profile dir, so it can never collide with the daemon's 9322, any other
 * suite's fixed port, or a sibling agent's concurrently-running suite.
 * Chrome is deliberately left running afterward (detached) — the same
 * convention every other suite in this repo follows; see
 * chrome/launch.ts's ensureChrome doc comment.
 *
 * Run: npx tsx test/v49b.ensure-chrome.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allocateFreePort, cdpAlive, ensureChrome } from '../src/chrome/launch.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

async function main(): Promise<void> {
  /* ===================== 1: ensureChrome concurrency dedupe (REAL Chrome) ===================== */
  console.log('=== v49b 1/1: ensureChrome concurrency dedupe (REAL Chrome, dedicated port) ===');
  {
    const port = await allocateFreePort();
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v49b-chrome-'));
    const results = await Promise.allSettled([
      ensureChrome({ port, profileDir, headless: true }),
      ensureChrome({ port, profileDir, headless: true }),
      ensureChrome({ port, profileDir, headless: true }),
    ]);
    check(
      'three concurrent ensureChrome() calls on a COLD port all resolve without throwing (no double-spawn race)',
      results.every((r) => r.status === 'fulfilled'),
    );
    check('the port is genuinely alive (CDP responds) once the race settles', await cdpAlive(port));
    // Chrome is intentionally left running detached — see this file's header
    // comment; every other suite in this repo (e.g. v45) follows the same
    // convention rather than killing a process this codebase never tracks a
    // PID for.
  }

  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} v49b ensure-chrome checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
