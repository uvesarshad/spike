/* V151 — the published slim-result JSON schema (E9): a real slimReport() validates, bad shapes do not,
 * and the schema's version const tracks REPORT_SCHEMA_VERSION. */
import fs from 'node:fs';
import AjvModule from 'ajv';
import { REPORT_SCHEMA_VERSION, slimReport, type Report } from '../src/report/report.js';

const check = (l: string, ok: boolean) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`); if (!ok) process.exitCode = 1; };
const schema = JSON.parse(fs.readFileSync(new URL('../schema/slim-result.schema.json', import.meta.url), 'utf8'));
const Ajv: any = (AjvModule as any).default ?? AjvModule;
const validate = new Ajv({ strict: false }).compile(schema);
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const report = (verdict: Report['verdict'], extra: Partial<Report> = {}): Report => ({
  runId: 'r1', task: 'place an order', url: 'http://localhost:3000', verdict,
  reason: 'Place order threw', console_error: 'TypeError: order.total is undefined',
  evidence_paths: ['artifacts/r1/step-00.png'],
  steps: [{ index: 0, ts: 1, ok: false, action: { type: 'click', nodeId: 'n1' }, target: { role: 'button', name: 'Place order' } }],
  failing_step: { index: 0, action: { type: 'click', nodeId: 'n1' }, description: 'click n1' },
  spendSummary: { freeCalls: 1, paidCalls: 2, totalTokens: 1200, estimatedUsd: 0.004 },
  ...extra,
} as unknown as Report);

for (const v of ['pass', 'fail', 'uncertain'] as const) {
  const s = slimReport(report(v, v === 'pass' ? { failing_step: null, console_error: null } : {}));
  check(`a real ${v} slim result validates`, validate(s) as boolean);
}
check('the fail result carries fix_hint and still validates', typeof slimReport(report('fail')).fix_hint === 'string');
check('extra fields (script/healed) are allowed', validate({ script: 'x', healed: false, ...slimReport(report('fail')) }) as boolean);
check('missing verdict is rejected', !validate({ ...slimReport(report('pass')), verdict: undefined }));
check('unknown verdict is rejected', !validate({ ...slimReport(report('pass')), verdict: 'maybe' }));
check('wrong schemaVersion is rejected', !validate({ ...slimReport(report('pass')), schemaVersion: 2 }));
check('schema version const matches REPORT_SCHEMA_VERSION', schema.properties.schemaVersion.const === REPORT_SCHEMA_VERSION);
check('schema directory ships in the package', pkg.files.includes('schema'));
