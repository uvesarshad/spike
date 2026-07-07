import { strict as assert } from 'node:assert';
import { ActionSchema } from '../src/driver/actions.js';
import { scriptFromReport, toPlaywrightSpec } from '../src/recorder/script.js';
import type { Report } from '../src/report/report.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const parsed = ActionSchema.safeParse({
  type: 'assert_visual',
  expectation: 'toast appears after saving',
  mode: 'video',
});
check('ActionSchema accepts assert_visual video mode', parsed.success);

const report: Report = {
  verdict: 'pass',
  failing_step: null,
  console_error: null,
  evidence_paths: [],
  reason: 'ok',
  runId: 'r-video',
  task: 'verify save toast',
  url: 'http://localhost/video',
  steps: [
    {
      index: 0,
      action: { type: 'assert_visual', expectation: 'toast appears after saving', mode: 'video' },
      description: 'video check',
      ok: true,
      console: [],
      network: [],
      ts: 0,
    },
  ],
  model_trace: [],
  durationMs: 1,
  tokenEstimate: 0,
};

const script = scriptFromReport(report);
check('scriptFromReport preserves video assertion mode', script.steps[0]?.type === 'assert_visual' && script.steps[0].mode === 'video');

const spec = toPlaywrightSpec({
  ...script,
  steps: [
    ...script.steps,
    { type: 'assert_dom', target: { role: `custom'role`, name: 'Result' }, contains: 'Saved' },
  ],
});
check('Playwright twin labels video assertions', spec.includes('// video check'));
check('Playwright twin escapes unknown role names', spec.includes(`page.getByRole("custom'role"`));

assert.equal(checks.filter(([, ok]) => !ok).length, 0);
console.log(`\n${checks.length}/${checks.length} v30 video assertion checks passed`);
