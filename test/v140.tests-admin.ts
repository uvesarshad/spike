/* v140 — A10: saved-test admin (list / quarantine / release / heal review).
 * Temp dirs only; no browser. Run: npx tsx test/v140.tests-admin.ts */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveScript, type QaScript } from '../src/recorder/script.js';
import { acceptHeal, candidatePath, listHealCandidates, listSavedTests, quarantineTest, rejectHeal, releaseTest } from '../src/recorder/tests-admin.js';
import { isQuarantined } from '../src/engine.js';

const checks: [string, boolean][] = [];
const check = (l: string, ok: boolean) => { checks.push([l, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v140-'));
const script = (label: string): QaScript => ({
  version: 1, name: 'checkout', task: 'check out', url: 'http://localhost:9401/', sourceRunId: 'r1', createdAt: '2026-01-01T00:00:00Z',
  steps: [
    { type: 'navigate', url: 'http://localhost:9401/' },
    { type: 'click', target: { role: 'button', name: label } },
    { type: 'assert_dom', target: { role: 'status', name: 'Msg' }, contains: 'Order confirmed' },
  ],
});

const { jsonPath, specPath } = saveScript(script('Buy'), root);
let rows = listSavedTests(root);
check('list shows the saved test, not parked', rows.length === 1 && rows[0].name === 'checkout' && !rows[0].quarantined && rows[0].lastResult === undefined);

quarantineTest('checkout', 'flaky on CI', root);
check('quarantine parks it with a reason', isQuarantined('checkout', root) && listSavedTests(root)[0].quarantineReason === 'flaky on CI');
check('release un-parks it', releaseTest('checkout', root) === true && !isQuarantined('checkout', root));
let threw = false;
try { quarantineTest('nope', undefined, root); } catch { threw = true; }
check('unknown name is an error, not a silent no-op', threw);

// heal review: candidate held back beside the script
fs.writeFileSync(candidatePath('checkout', root), JSON.stringify({ ...script('Purchase'), healedFrom: { runId: 'r2', failedStep: 1, healedAt: 'x' } }));
check('candidate is not listed as a saved test', listSavedTests(root).length === 1 && listSavedTests(root)[0].hasHealCandidate);
const review = listHealCandidates(root);
check('review lists candidate with a diff', review.length === 1 && review[0].name === 'checkout' && review[0].changes.length > 0);

const before = fs.readFileSync(jsonPath, 'utf8');
rejectHeal('checkout', root);
check('reject leaves the script byte-identical and removes the candidate', fs.readFileSync(jsonPath, 'utf8') === before && !fs.existsSync(candidatePath('checkout', root)));

fs.writeFileSync(candidatePath('checkout', root), JSON.stringify(script('Purchase')));
const specBefore = fs.readFileSync(specPath, 'utf8');
acceptHeal('checkout', root);
check('accept rewrites the script and re-emits the spec', fs.readFileSync(jsonPath, 'utf8').includes('Purchase') && fs.readFileSync(specPath, 'utf8') !== specBefore && !fs.existsSync(candidatePath('checkout', root)));
threw = false;
try { acceptHeal('checkout', root); } catch { threw = true; }
check('accept with nothing waiting is an error', threw);

fs.rmSync(root, { recursive: true, force: true });
const failed = checks.filter(([, ok]) => !ok);
if (failed.length) { console.error(`${failed.length} failed`); process.exit(1); }
console.log(`\nV140 checks passed (${checks.length}).`);
