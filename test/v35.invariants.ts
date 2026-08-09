/* V35 — Tier 0 invariant oracle (A24): deterministic, zero-model assertions
 * true of essentially every correct page. Pure unit coverage, no Chrome/model
 * calls — checkProbeInvariants is exercised with hand-built "probe output"
 * objects standing in for what INVARIANT_PROBE_JS would return over CDP.
 *
 * Covers:
 *  - each rule fires on a positive case, stays silent on a clean case
 *  - config.disabled and config.allowText are honoured
 *  - checkProbeInvariants survives junk input without throwing
 *  - secret redaction in evidence
 *  - same-origin filtering for the network invariant
 */

import assert from 'node:assert/strict';
import type { AxSnapshot } from '../src/ports/browser-port.js';
import {
  checkAxInvariants,
  checkDrainInvariants,
  checkProbeInvariants,
  INVARIANT_PROBE_JS,
  type InvariantViolation,
} from '../src/assertions/invariants.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

function rules(violations: InvariantViolation[]): string[] {
  return violations.map((v) => v.rule);
}

function has(violations: InvariantViolation[], rule: string): boolean {
  return violations.some((v) => v.rule === rule);
}

// ---------------------------------------------------------------------------
// checkDrainInvariants — drain-derived rules
// ---------------------------------------------------------------------------

{
  const violations = checkDrainInvariants({
    console: [{ ts: 1, level: 'page-error', text: '[PAGE-ERROR] Uncaught TypeError: order.total is undefined' }],
    network: [],
    url: 'https://shop.example.com/checkout',
  });
  check('page-error fires on an uncaught page error', has(violations, 'page-error'));
  check('page-error is severity error', violations.find((v) => v.rule === 'page-error')?.severity === 'error');
}

{
  const violations = checkDrainInvariants({
    console: [{ ts: 1, level: 'page-error', text: 'Uncaught (in promise) Error: fetch failed' }],
    network: [],
    url: 'https://shop.example.com/checkout',
  });
  check('unhandled-rejection fires and is distinct from page-error', has(violations, 'unhandled-rejection') && !has(violations, 'page-error'));
}

{
  const violations = checkDrainInvariants({
    console: [{ ts: 1, level: 'error', text: 'console.error: bad thing happened' }],
    network: [],
    url: 'https://shop.example.com/checkout',
  });
  check('console-error fires on level "error"', has(violations, 'console-error'));
}

{
  const clean = checkDrainInvariants({
    console: [
      { ts: 1, level: 'log', text: 'hello' },
      { ts: 2, level: 'info', text: 'loaded' },
      { ts: 3, level: 'warn', text: 'deprecation notice' },
    ],
    network: [],
    url: 'https://shop.example.com/checkout',
  });
  check('clean console drain produces no violations', clean.length === 0);
}

{
  const violations = checkDrainInvariants({
    console: [],
    network: [{ ts: 1, method: 'GET', url: 'https://shop.example.com/api/order', status: 500 }],
    url: 'https://shop.example.com/checkout',
  });
  check('network-error fires on same-origin 5xx', has(violations, 'network-error'));
  check('same-origin 5xx is severity error', violations.find((v) => v.rule === 'network-error')?.severity === 'error');
}

{
  const violations = checkDrainInvariants({
    console: [],
    network: [{ ts: 1, method: 'GET', url: 'https://shop.example.com/api/missing', status: 404 }],
    url: 'https://shop.example.com/checkout',
  });
  check('network-error fires on same-origin 4xx', has(violations, 'network-error'));
  check('same-origin 4xx is severity warn', violations.find((v) => v.rule === 'network-error')?.severity === 'warn');
}

{
  const violations = checkDrainInvariants({
    console: [],
    network: [{ ts: 1, method: 'GET', url: 'https://ads.thirdparty.com/pixel', status: 404 }],
    url: 'https://shop.example.com/checkout',
  });
  check('third-party 404 does NOT fire (same-origin filtering)', violations.length === 0);
}

{
  const violations = checkDrainInvariants({
    console: [],
    network: [{ ts: 1, method: 'GET', url: 'https://shop.example.com/api/order', failed: true, errorText: 'net::ERR_CONNECTION_RESET' }],
    url: 'https://shop.example.com/checkout',
  });
  check('network-error fires on same-origin connection failure with no status', has(violations, 'network-error'));
}

{
  const violations = checkDrainInvariants({
    console: [{ ts: 1, level: 'page-error', text: '[PAGE-ERROR] boom' }],
    network: [],
    url: 'https://shop.example.com/checkout',
    config: { disabled: ['page-error'] },
  });
  check('config.disabled suppresses a drain rule', violations.length === 0);
}

// ---------------------------------------------------------------------------
// checkProbeInvariants — probe-derived rules
// ---------------------------------------------------------------------------

{
  const violations = checkProbeInvariants({
    renderedUndefined: ['Total: $undefined'],
    brokenImages: [],
    overflow: null,
    landmarks: { hasMain: true, hasH1: true, mainTextLength: 40 },
    stuckLoading: [],
    duplicateIds: [],
  });
  check('rendered-undefined fires on a positive case', has(violations, 'rendered-undefined'));
  check('rendered-undefined is severity error', violations.find((v) => v.rule === 'rendered-undefined')?.severity === 'error');
}

{
  const clean = checkProbeInvariants({
    renderedUndefined: [],
    brokenImages: [],
    overflow: null,
    landmarks: { hasMain: true, hasH1: true, mainTextLength: 40 },
    stuckLoading: [],
    duplicateIds: [],
  });
  check('a fully clean probe result produces no violations', clean.length === 0);
}

{
  const violations = checkProbeInvariants({
    renderedUndefined: ['Balance is null this month'],
    brokenImages: [],
    overflow: null,
    landmarks: { hasMain: true, hasH1: true, mainTextLength: 40 },
    stuckLoading: [],
    duplicateIds: [],
  });
  check('rendered-undefined fires without an allowlist', has(violations, 'rendered-undefined'));

  const allowed = checkProbeInvariants(
    {
      renderedUndefined: ['Balance is null this month'],
      brokenImages: [],
      overflow: null,
      landmarks: { hasMain: true, hasH1: true, mainTextLength: 40 },
      stuckLoading: [],
      duplicateIds: [],
    },
    { allowText: ['Balance is null'] },
  );
  check('config.allowText suppresses a legitimate "null" string', allowed.length === 0);
}

{
  const violations = checkProbeInvariants({
    renderedUndefined: [],
    brokenImages: ['https://shop.example.com/img/broken.png'],
    overflow: null,
    landmarks: { hasMain: true, hasH1: true, mainTextLength: 40 },
    stuckLoading: [],
    duplicateIds: [],
  });
  check('broken-image fires on a positive case', has(violations, 'broken-image'));
}

{
  const violations = checkProbeInvariants({
    renderedUndefined: [],
    brokenImages: [],
    overflow: { scrollWidth: 1600, clientWidth: 1280 },
    landmarks: { hasMain: true, hasH1: true, mainTextLength: 40 },
    stuckLoading: [],
    duplicateIds: [],
  });
  check('layout-overflow fires on a positive case', has(violations, 'layout-overflow'));
  check('layout-overflow is severity warn', violations.find((v) => v.rule === 'layout-overflow')?.severity === 'warn');
}

{
  const noMain = checkProbeInvariants({
    renderedUndefined: [],
    brokenImages: [],
    overflow: null,
    landmarks: { hasMain: false, hasH1: true, mainTextLength: 0 },
    stuckLoading: [],
    duplicateIds: [],
  });
  check('empty-required-region fires when there is no <main>', has(noMain, 'empty-required-region'));

  const noH1 = checkProbeInvariants({
    renderedUndefined: [],
    brokenImages: [],
    overflow: null,
    landmarks: { hasMain: true, hasH1: false, mainTextLength: 40 },
    stuckLoading: [],
    duplicateIds: [],
  });
  check('empty-required-region fires when there is no <h1>', has(noH1, 'empty-required-region'));

  const emptyMain = checkProbeInvariants({
    renderedUndefined: [],
    brokenImages: [],
    overflow: null,
    landmarks: { hasMain: true, hasH1: true, mainTextLength: 0 },
    stuckLoading: [],
    duplicateIds: [],
  });
  check('empty-required-region fires when <main> has no text', has(emptyMain, 'empty-required-region'));
}

{
  const violations = checkProbeInvariants({
    renderedUndefined: [],
    brokenImages: [],
    overflow: null,
    landmarks: { hasMain: true, hasH1: true, mainTextLength: 40 },
    stuckLoading: ['div.skeleton-card'],
    duplicateIds: [],
  });
  check('stuck-loading fires on a positive case', has(violations, 'stuck-loading'));
  check('stuck-loading is severity warn', violations.find((v) => v.rule === 'stuck-loading')?.severity === 'warn');
}

{
  const violations = checkProbeInvariants({
    renderedUndefined: [],
    brokenImages: [],
    overflow: null,
    landmarks: { hasMain: true, hasH1: true, mainTextLength: 40 },
    stuckLoading: [],
    duplicateIds: [{ id: 'email', count: 2 }],
  });
  check('duplicate-ids fires on a positive case', has(violations, 'duplicate-ids'));
  check('duplicate-ids is severity error', violations.find((v) => v.rule === 'duplicate-ids')?.severity === 'error');
}

{
  const violations = checkProbeInvariants(
    {
      renderedUndefined: ['undefined'],
      brokenImages: [],
      overflow: null,
      landmarks: { hasMain: true, hasH1: true, mainTextLength: 40 },
      stuckLoading: [],
      duplicateIds: [],
    },
    { disabled: ['rendered-undefined'] },
  );
  check('config.disabled suppresses a probe rule', violations.length === 0);
}

// ---- defensive parsing: must never throw ----

for (const junk of [null, undefined, 'a string', 42, [], true, { renderedUndefined: 'not-an-array' }, { landmarks: 'nope' }, { duplicateIds: [null, 5, 'x', { id: 42 }] }]) {
  let threw = false;
  let result: InvariantViolation[] = [];
  try {
    result = checkProbeInvariants(junk as unknown);
  } catch {
    threw = true;
  }
  check(`checkProbeInvariants survives junk input (${JSON.stringify(junk)})`, !threw && Array.isArray(result));
}

{
  // probe-shaped error payload (what a hostile/broken page's outer catch returns)
  const result = checkProbeInvariants({ error: 'ReferenceError: window is not defined' });
  check('checkProbeInvariants handles a probe error payload without throwing', Array.isArray(result) && result.length === 0);
}

// ---------------------------------------------------------------------------
// secret redaction
// ---------------------------------------------------------------------------

{
  const secret = 'sk-live-abcdefghijklmnopqrstuvwx';
  const violations = checkDrainInvariants({
    console: [{ ts: 1, level: 'error', text: `auth failed for key ${secret}` }],
    network: [],
    url: 'https://shop.example.com/checkout',
  });
  const evidence = violations.find((v) => v.rule === 'console-error')?.evidence ?? '';
  check('secret-like text is redacted from evidence', !evidence.includes(secret) && evidence.includes('[REDACTED]'));
}

{
  const longText = 'x'.repeat(500);
  const violations = checkProbeInvariants({
    renderedUndefined: [`prefix undefined ${longText}`],
    brokenImages: [],
    overflow: null,
    landmarks: { hasMain: true, hasH1: true, mainTextLength: 40 },
    stuckLoading: [],
    duplicateIds: [],
  });
  const evidence = violations.find((v) => v.rule === 'rendered-undefined')?.evidence ?? '';
  check('long evidence is truncated', evidence.length <= 201);
}

// ---------------------------------------------------------------------------
// checkAxInvariants
// ---------------------------------------------------------------------------

{
  const ax: AxSnapshot = {
    text: '',
    truncated: false,
    root: {
      id: 'n0',
      role: 'RootWebArea',
      name: 'Fixture',
      children: [
        { id: 'n1', role: 'button', name: '' },
        { id: 'n2', role: 'button', name: 'Place order' },
        { id: 'n3', role: 'textbox', value: 'hello' },
      ],
    },
  };
  const violations = checkAxInvariants(ax);
  check('unlabelled-control fires for an unnamed button', has(violations, 'unlabelled-control'));
  check(
    'unlabelled-control does not fire for a named button or a textbox with a value',
    violations.filter((v) => v.rule === 'unlabelled-control').length === 1,
  );
}

{
  const ax: AxSnapshot = {
    text: '',
    truncated: false,
    root: { id: 'n0', role: 'RootWebArea', name: 'Fixture', children: [{ id: 'n1', role: 'heading', name: 'Checkout' }] },
  };
  const violations = checkAxInvariants(ax);
  check('checkAxInvariants is clean when nothing interactive is unlabelled', violations.length === 0);
}

{
  const ax: AxSnapshot = {
    text: '',
    truncated: false,
    root: { id: 'n0', role: 'RootWebArea', name: 'Fixture', children: [{ id: 'n1', role: 'button', name: '' }] },
  };
  const violations = checkAxInvariants(ax, { disabled: ['unlabelled-control'] });
  check('config.disabled suppresses an AX rule', violations.length === 0);
}

// ---------------------------------------------------------------------------
// INVARIANT_PROBE_JS sanity
// ---------------------------------------------------------------------------

{
  check('INVARIANT_PROBE_JS is a non-trivial IIFE string', typeof INVARIANT_PROBE_JS === 'string' && INVARIANT_PROBE_JS.includes('renderedUndefined'));
  assert.doesNotThrow(() => new Function(`return ${INVARIANT_PROBE_JS}`));
  check('INVARIANT_PROBE_JS parses as valid JavaScript', true);
}

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  console.error(`\n${failed.length} checks failed:`);
  for (const [label] of failed) console.error(` - ${label}`);
  process.exit(1);
}

console.log(`\nV35 invariant-oracle checks passed (${checks.length}).`);
