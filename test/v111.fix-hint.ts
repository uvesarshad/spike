/* v111 — A6: the slim result carries a bounded `fix_hint` on `fail` only. */
import { slimReport, type Report } from '../src/report/report.js';
import { MAX_FIX_HINT_CHARS } from '../src/vibe/fix-prompt.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

function report(verdict: Report['verdict'], extra: Partial<Report> = {}): Report {
  return {
    runId: 'r1',
    task: 'place an order',
    url: 'http://localhost:3000',
    verdict,
    reason: 'Place order threw',
    console_error: 'TypeError: order.total is undefined',
    evidence_paths: [],
    steps: [
      { index: 0, ts: 1, ok: false, action: { type: 'click', nodeId: 'n1' }, target: { role: 'button', name: 'Place order' } },
    ],
    failing_step: { index: 0 },
    ...extra,
  } as unknown as Report;
}

const fail = slimReport(report('fail'));
check('present on fail', typeof fail.fix_hint === 'string' && fail.fix_hint.length > 0);
check('mentions the console error', Boolean(fail.fix_hint?.includes('order.total')));
check('absent on pass', slimReport(report('pass')).fix_hint === undefined);
check('absent on uncertain', slimReport(report('uncertain')).fix_hint === undefined);
check('key not serialised on pass', !('fix_hint' in slimReport(report('pass'))));
const huge = slimReport(report('fail', { console_error: 'x'.repeat(50_000), reason: 'y'.repeat(50_000) }));
check('length-capped', (huge.fix_hint?.length ?? 0) <= MAX_FIX_HINT_CHARS);

if (checks.some(([, ok]) => !ok)) process.exit(1);
