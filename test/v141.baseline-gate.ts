/* v141 — A10: --baseline / --fail-on-regression. Pure gate + flag/config plumbing; no browser.
 * Run: npx tsx test/v141.baseline-gate.ts */
import { applyRegressionGate } from '../src/engine.js';
import { loadConfig } from '../src/config.js';

const checks: [string, boolean][] = [];
const check = (l: string, ok: boolean) => { checks.push([l, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`); };
const mk = (verdict: 'pass' | 'fail' | 'uncertain', clean: boolean) => ({ verdict, reason: 'ok', differential: { mode: 'baseline' as const, clean, axChanges: 2, networkChanges: 1, detail: [] } });

let r = mk('pass', false);
check('regression + flag -> fail', applyRegressionGate(r, true) && r.verdict === 'fail' && r.reason.includes('baseline'));
r = mk('pass', false);
check('regression without flag -> verdict unchanged', !applyRegressionGate(r, false) && r.verdict === 'pass');
r = mk('pass', true);
check('clean diff + flag -> still pass', !applyRegressionGate(r, true) && r.verdict === 'pass');
r = mk('uncertain', false);
check('uncertain is never rewritten', !applyRegressionGate(r, true) && r.verdict === 'uncertain');
const noDiff = { verdict: 'pass' as const, reason: 'ok' };
check('no differential (first run stores the baseline) -> pass', !applyRegressionGate(noDiff, true) && noDiff.verdict === 'pass');

const cfg = loadConfig({ differential: true, failOnRegression: true });
check('config keys differential/failOnRegression are honoured', cfg.differential && cfg.failOnRegression);
check('failOnRegression defaults off', loadConfig().failOnRegression === false || process.env.SPIKE_FAIL_ON_REGRESSION !== undefined);

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) { console.error(`${failed.length} failed`); process.exit(1); }
console.log(`\nV141 checks passed (${checks.length}).`);
