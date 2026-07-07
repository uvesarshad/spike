/* v27 - Runtime data, extraction state, and fake local email provider.
 *
 * This is intentionally offline and driver-free. Driver/recorder integration
 * hooks are documented in docs/architecture/data-flow.md and docs/modules/recorder.md.
 *
 * Run: npx tsx test/v27.run-data.ts
 */

import assert from 'node:assert/strict';
import {
  createRunDataState,
  extractRegexToRunData,
  getRunData,
  recordExtraction,
  resolveRunPlaceholders,
  RunDataNotFoundError,
} from '../src/run-data/index.js';
import { FakeLocalEmailProvider, findOtp } from '../src/email/index.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const state = createRunDataState({ shortid: 'abc123', emailDomain: 'mail.test' });
check('shortid is seeded deterministically', state.run.shortid === 'abc123');
check('email is generated from shortid + domain', state.run.email === 'qa+abc123@mail.test');
check('name and phone defaults exist', Boolean(state.run.name) && /^\+1555\d{4}$/.test(state.run.phone));

const resolved = resolveRunPlaceholders('Sign up {{run.email}} as {{run.name}} / {{run.phone}}', state);
check('resolver replaces all built-in {{run.*}} placeholders', resolved.text === `Sign up ${state.run.email} as ${state.run.name} / ${state.run.phone}`);
check('resolver returns resolution metadata', resolved.resolved.map((r) => r.key).join(',') === 'email,name,phone');

let missing: unknown;
try {
  resolveRunPlaceholders('Order {{run.orderId}}', state);
} catch (e) {
  missing = e;
}
check('unknown run placeholder throws by default', missing instanceof RunDataNotFoundError && missing.key === 'orderId');

const preserved = resolveRunPlaceholders('Order {{run.orderId}}', state, { unknown: 'preserve' });
check('unknown run placeholder can be preserved for planner-visible text', preserved.text === 'Order {{run.orderId}}');

const extraction = recordExtraction(state, {
  key: 'orderId',
  value: 'ORD-42',
  source: 'dom',
  label: 'confirmation number',
  at: '2026-07-07T00:00:00.000Z',
});
check('recordExtraction writes run value', getRunData(state, 'orderId') === 'ORD-42');
check('recordExtraction stores source metadata', state.extractions.orderId === extraction && extraction.source === 'dom');
check('extracted values resolve as later {{run.*}} placeholders', resolveRunPlaceholders('Track {{run.orderId}}', state).text === 'Track ORD-42');

const regexState = createRunDataState({ shortid: 'rx' });
const found = extractRegexToRunData(regexState, 'Receipt total: $19.99; Order #ZX-900', [
  { key: 'total', pattern: /total:\s*\$([0-9.]+)/i, label: 'receipt total' },
  { key: 'orderId', pattern: /Order #(?<id>[A-Z]+-\d+)/, group: 'id' },
]);
check('extractRegexToRunData records multiple values', found.length === 2 && regexState.run.total === '19.99' && regexState.run.orderId === 'ZX-900');

const email = new FakeLocalEmailProvider();
email.deliver({
  to: state.run.email,
  subject: 'Your verification code',
  text: 'Use 482913 to finish signup.',
  receivedAt: '2026-07-07T01:00:00.000Z',
});
email.deliver({
  to: 'other@mail.test',
  subject: 'Your verification code',
  text: 'Use 111111 to finish signup.',
});

const messages = await email.listMessages({ to: state.run.email, subjectIncludes: 'verification' });
check('fake email provider filters by recipient and subject', messages.length === 1 && messages[0].to === state.run.email);
check('findOtp extracts code from matching email', messages[0] !== undefined && findOtp(messages[0]) === '482913');

const waited = await email.waitForMessage({ to: state.run.email, bodyIncludes: '482913' }, { timeoutMs: 50, intervalMs: 5 });
check('waitForMessage returns an existing local email', waited?.id === messages[0].id);

const timedOut = await email.waitForMessage({ to: state.run.email, bodyIncludes: 'never arrives' }, { timeoutMs: 20, intervalMs: 5 });
check('waitForMessage returns null on timeout', timedOut === null);

assert.throws(() => recordExtraction(state, { key: 'bad.key', value: 'x', source: 'manual' }), /invalid run data key/);
check('unsafe extraction keys are rejected', true);

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v27 checks passed`);
process.exit(failed.length ? 1 : 0);
