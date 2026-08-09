/* V42 — A5 (P0) precise assertion vocabulary. Pure unit coverage, no Chrome/
 * model calls: evaluateAssertion() is exercised against small in-memory
 * AxSnapshot/NetworkEntry/ConsoleEntry fixtures standing in for what the
 * driver loop collects every step.
 *
 * Covers every verb, pass and fail, plus the specific case the audit (A5)
 * calls out by name: assert_dom's substring semantics let "Order" match an
 * "Order failed" toast — assert_text mode:'contains' reproduces that (by
 * design, unchanged), while mode:'exact' correctly rejects it.
 *
 * Run: npx tsx test/v42.assertions.ts
 */

import type { AxNode, AxSnapshot, ConsoleEntry, NetworkEntry } from '../src/ports/browser-port.js';
import { evaluateAssertion, type AssertionContext } from '../src/assertions/dom-assertions.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function ordersPageAx(): AxSnapshot {
  const root: AxNode = {
    id: 'n0',
    role: 'RootWebArea',
    name: 'Orders',
    children: [
      { id: 'n1', role: 'heading', name: 'Order failed' },
      { id: 'n2', role: 'button', name: 'Place order', states: [] },
      { id: 'n3', role: 'button', name: 'Retry', states: ['disabled'] },
      { id: 'n4', role: 'listitem', name: 'Order #1001' },
      { id: 'n5', role: 'listitem', name: 'Order #1002' },
      { id: 'n6', role: 'listitem', name: 'Order #1003' },
      { id: 'n7', role: 'checkbox', name: 'Remember me', states: ['checked'] },
      { id: 'n8', role: 'textbox', name: 'Email', states: ['focused'] },
    ],
  };
  return { root, text: 'Order failed\nPlace order\nRetry\nOrder #1001\nOrder #1002\nOrder #1003', truncated: false };
}

function ctxFor(overrides: Partial<AssertionContext> = {}): AssertionContext {
  return {
    ax: ordersPageAx(),
    url: 'https://shop.example.com/checkout?utm_source=ads&ref=1',
    network: [],
    console: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// assert_text
// ---------------------------------------------------------------------------
console.log('=== assert_text ===');
{
  const ctx = ctxFor();

  // The A5 audit example: assert_dom-style "contains" passes on the toast...
  const containsHit = evaluateAssertion({ type: 'assert_text', target: 'n1', mode: 'contains', value: 'Order' }, ctx);
  check('contains "Order" PASSES against "Order failed" (unchanged substring semantics)', containsHit.ok);

  // ...but exact correctly distinguishes it from the real thing.
  const exactMiss = evaluateAssertion({ type: 'assert_text', target: 'n1', mode: 'exact', value: 'Order' }, ctx);
  check('exact "Order" FAILS against "Order failed" (the precision assert_dom lacked)', !exactMiss.ok);

  const exactHit = evaluateAssertion({ type: 'assert_text', target: 'n1', mode: 'exact', value: 'Order failed' }, ctx);
  check('exact matches the full trimmed/collapsed text', exactHit.ok);

  const exactWhitespace = evaluateAssertion({ type: 'assert_text', target: 'n1', mode: 'exact', value: '  Order   failed  ' }, ctx);
  check('exact collapses internal/leading/trailing whitespace on both sides', exactWhitespace.ok);

  const caseSensitive = evaluateAssertion({ type: 'assert_text', target: 'n1', mode: 'exact', value: 'order failed' }, ctx);
  check('exact is case-sensitive (deliberately stricter than contains)', !caseSensitive.ok);

  const containsCaseInsensitive = evaluateAssertion({ type: 'assert_text', target: 'n1', mode: 'contains', value: 'order FAILED' }, ctx);
  check('contains is case-insensitive', containsCaseInsensitive.ok);

  const noTarget = evaluateAssertion({ type: 'assert_text', mode: 'contains', value: 'Place order' }, ctx);
  check('omitted target searches the whole serialized page text', noTarget.ok);

  const missingNode = evaluateAssertion({ type: 'assert_text', target: 'nope', mode: 'contains', value: 'x' }, ctx);
  check('missing target node fails cleanly (not throw)', !missingNode.ok);

  const regexHit = evaluateAssertion({ type: 'assert_text', target: 'n4', mode: 'regex', value: 'Order #\\d+' }, ctx);
  check('regex mode matches', regexHit.ok);

  const regexMiss = evaluateAssertion({ type: 'assert_text', target: 'n4', mode: 'regex', value: 'Invoice #\\d+' }, ctx);
  check('regex mode fails to match', !regexMiss.ok);

  let threw = false;
  let invalidRegexResult;
  try {
    invalidRegexResult = evaluateAssertion({ type: 'assert_text', target: 'n4', mode: 'regex', value: '[unterminated' }, ctx);
  } catch {
    threw = true;
  }
  check('invalid regex FAILS the assertion, never throws', !threw && invalidRegexResult?.ok === false);

  check('every result has a human-readable detail', typeof containsHit.detail === 'string' && containsHit.detail.length > 0);
}

// ---------------------------------------------------------------------------
// assert_count
// ---------------------------------------------------------------------------
console.log('\n=== assert_count ===');
{
  const ctx = ctxFor();

  const eqPass = evaluateAssertion({ type: 'assert_count', role: 'listitem', expected: 3, comparator: 'eq' }, ctx);
  check('eq comparator passes on exact match', eqPass.ok);

  const eqFail = evaluateAssertion({ type: 'assert_count', role: 'listitem', expected: 2, comparator: 'eq' }, ctx);
  check('eq comparator fails on mismatch', !eqFail.ok);

  const gtePass = evaluateAssertion({ type: 'assert_count', role: 'listitem', expected: 2, comparator: 'gte' }, ctx);
  check('gte comparator passes when actual exceeds expected', gtePass.ok);

  const gteFail = evaluateAssertion({ type: 'assert_count', role: 'listitem', expected: 4, comparator: 'gte' }, ctx);
  check('gte comparator fails when actual is below expected', !gteFail.ok);

  const ltePass = evaluateAssertion({ type: 'assert_count', role: 'listitem', expected: 3, comparator: 'lte' }, ctx);
  check('lte comparator passes at the boundary', ltePass.ok);

  const lteFail = evaluateAssertion({ type: 'assert_count', role: 'listitem', expected: 1, comparator: 'lte' }, ctx);
  check('lte comparator fails when actual exceeds expected', !lteFail.ok);

  const byName = evaluateAssertion({ type: 'assert_count', role: 'button', name: 'Place order', expected: 1, comparator: 'eq' }, ctx);
  check('name filter narrows the match', byName.ok);

  const byNameMiss = evaluateAssertion({ type: 'assert_count', role: 'button', name: 'Does not exist', expected: 0, comparator: 'eq' }, ctx);
  check('name filter with no matches counts zero (not an error)', byNameMiss.ok);

  const zero = evaluateAssertion({ type: 'assert_count', role: 'video', expected: 0, comparator: 'eq' }, ctx);
  check('a role with zero occurrences counts zero cleanly', zero.ok);
}

// ---------------------------------------------------------------------------
// assert_url
// ---------------------------------------------------------------------------
console.log('\n=== assert_url ===');
{
  const ctx = ctxFor({ url: 'https://shop.example.com/checkout?utm_source=ads&ref=1' });

  // exact ignores tracking params and query-param order, mirroring
  // action-cache.ts's normalizeUrlForActionCache intent.
  const exactIgnoresTracking = evaluateAssertion({ type: 'assert_url', mode: 'exact', value: 'https://shop.example.com/checkout?ref=1' }, ctx);
  check('exact url ignores utm_ tracking params', exactIgnoresTracking.ok);

  const exactCaseInsensitiveHost = evaluateAssertion({ type: 'assert_url', mode: 'exact', value: 'HTTPS://SHOP.EXAMPLE.COM/checkout?ref=1' }, ctx);
  check('exact url lowercases scheme/host', exactCaseInsensitiveHost.ok);

  const exactTrailingSlash = evaluateAssertion(
    { type: 'assert_url', mode: 'exact', value: 'https://shop.example.com/checkout/?ref=1' },
    ctxFor({ url: 'https://shop.example.com/checkout?ref=1' }),
  );
  check('exact url normalizes a trailing slash', exactTrailingSlash.ok);

  const exactDifferentPath = evaluateAssertion({ type: 'assert_url', mode: 'exact', value: 'https://shop.example.com/cart?ref=1' }, ctx);
  check('exact url fails on a different path', !exactDifferentPath.ok);

  const containsHit = evaluateAssertion({ type: 'assert_url', mode: 'contains', value: '/checkout' }, ctx);
  check('contains matches a substring of the raw url', containsHit.ok);

  const containsMiss = evaluateAssertion({ type: 'assert_url', mode: 'contains', value: '/cart' }, ctx);
  check('contains fails when the substring is absent', !containsMiss.ok);

  const regexHit = evaluateAssertion({ type: 'assert_url', mode: 'regex', value: '^https://shop\\.example\\.com/' }, ctx);
  check('regex matches the raw url', regexHit.ok);

  const invalidRegex = evaluateAssertion({ type: 'assert_url', mode: 'regex', value: '(unterminated' }, ctx);
  check('invalid url regex fails rather than throws', !invalidRegex.ok);
}

// ---------------------------------------------------------------------------
// assert_state
// ---------------------------------------------------------------------------
console.log('\n=== assert_state ===');
{
  const ctx = ctxFor();

  check('enabled passes for a node with no disabled state', evaluateAssertion({ type: 'assert_state', target: 'n2', state: 'enabled' }, ctx).ok);
  check('disabled fails for that same enabled node', !evaluateAssertion({ type: 'assert_state', target: 'n2', state: 'disabled' }, ctx).ok);
  check('disabled passes for a node with the disabled state', evaluateAssertion({ type: 'assert_state', target: 'n3', state: 'disabled' }, ctx).ok);
  check('enabled fails for that disabled node', !evaluateAssertion({ type: 'assert_state', target: 'n3', state: 'enabled' }, ctx).ok);
  check('checked passes for a checked checkbox', evaluateAssertion({ type: 'assert_state', target: 'n7', state: 'checked' }, ctx).ok);
  check('checked fails for an unchecked control', !evaluateAssertion({ type: 'assert_state', target: 'n2', state: 'checked' }, ctx).ok);
  check('focused passes for a focused textbox', evaluateAssertion({ type: 'assert_state', target: 'n8', state: 'focused' }, ctx).ok);
  check('focused fails for a non-focused node', !evaluateAssertion({ type: 'assert_state', target: 'n2', state: 'focused' }, ctx).ok);
  check('visible passes for a present, non-hidden node', evaluateAssertion({ type: 'assert_state', target: 'n2', state: 'visible' }, ctx).ok);

  const missing = evaluateAssertion({ type: 'assert_state', target: 'nope', state: 'enabled' }, ctx);
  check('missing target fails for a positive state (cannot verify)', !missing.ok);

  const missingIsHidden = evaluateAssertion({ type: 'assert_state', target: 'nope', state: 'hidden' }, ctx);
  check('missing target PASSES "hidden" (absent from the AX tree is the hidden signal)', missingIsHidden.ok);
}

// ---------------------------------------------------------------------------
// assert_network
// ---------------------------------------------------------------------------
console.log('\n=== assert_network ===');
{
  const network: NetworkEntry[] = [
    { ts: 1, method: 'POST', url: 'https://shop.example.com/api/order', status: 200 },
    { ts: 2, method: 'GET', url: 'https://shop.example.com/api/inventory', status: 404, clientError: true },
    { ts: 3, method: 'GET', url: 'https://shop.example.com/api/broken', status: 500, failed: true },
    { ts: 4, method: 'GET', url: 'https://ads.thirdparty.com/pixel', status: 204 },
  ];
  const ctx = ctxFor({ network });

  const byPattern = evaluateAssertion({ type: 'assert_network', urlPattern: '/api/order$' }, ctx);
  check('matches by url pattern alone', byPattern.ok);

  const byStatus = evaluateAssertion({ type: 'assert_network', urlPattern: '/api/order$', status: 200 }, ctx);
  check('matches by pattern + exact status', byStatus.ok);

  const wrongStatus = evaluateAssertion({ type: 'assert_network', urlPattern: '/api/order$', status: 500 }, ctx);
  check('fails when the matched request has a different status', !wrongStatus.ok);

  const by2xx = evaluateAssertion({ type: 'assert_network', urlPattern: '/api/order$', statusClass: '2xx' }, ctx);
  check('matches by statusClass 2xx', by2xx.ok);

  const by4xxViaClientError = evaluateAssertion({ type: 'assert_network', urlPattern: '/api/inventory$', statusClass: '4xx' }, ctx);
  check('statusClass 4xx matches via numeric status', by4xxViaClientError.ok);

  const by5xxViaFailed = evaluateAssertion({ type: 'assert_network', urlPattern: '/api/broken$', statusClass: '5xx' }, ctx);
  check('statusClass 5xx matches a transport-failed entry', by5xxViaFailed.ok);

  const absentPass = evaluateAssertion({ type: 'assert_network', urlPattern: '/api/nonexistent', absent: true }, ctx);
  check('absent:true passes when nothing matches the pattern', absentPass.ok);

  const absentFail = evaluateAssertion({ type: 'assert_network', urlPattern: '/api/order$', absent: true }, ctx);
  check('absent:true fails when a match IS found', !absentFail.ok);

  const absentWithStatus = evaluateAssertion({ type: 'assert_network', urlPattern: '/api/order$', status: 500, absent: true }, ctx);
  check('absent combines with status filter (no 500 for /api/order)', absentWithStatus.ok);

  const invalidPattern = evaluateAssertion({ type: 'assert_network', urlPattern: '(unterminated' }, ctx);
  check('invalid urlPattern regex fails rather than throws', !invalidPattern.ok);
}

// ---------------------------------------------------------------------------
// assert_no_console_errors
// ---------------------------------------------------------------------------
console.log('\n=== assert_no_console_errors ===');
{
  const clean: ConsoleEntry[] = [
    { ts: 1, level: 'log', text: 'hello' },
    { ts: 2, level: 'warn', text: 'deprecation notice' },
  ];
  const cleanCtx = ctxFor({ console: clean });
  check('passes when there are no error/page-error entries', evaluateAssertion({ type: 'assert_no_console_errors' }, cleanCtx).ok);

  const dirty: ConsoleEntry[] = [
    { ts: 1, level: 'page-error', text: 'Uncaught TypeError: order.total is undefined' },
    { ts: 2, level: 'error', text: 'console.error: known noisy analytics warning' },
  ];
  const dirtyCtx = ctxFor({ console: dirty });
  check('fails when page-error/error entries are present', !evaluateAssertion({ type: 'assert_no_console_errors' }, dirtyCtx).ok);

  const allowed = evaluateAssertion({ type: 'assert_no_console_errors', allow: ['known noisy analytics'] }, dirtyCtx);
  check('allowlist suppresses a matching error but not others', !allowed.ok);

  const allowAll = evaluateAssertion(
    { type: 'assert_no_console_errors', allow: ['order.total is undefined', 'known noisy analytics'] },
    dirtyCtx,
  );
  check('allowlist covering every offender passes', allowAll.ok);

  const caseInsensitiveAllow = evaluateAssertion({ type: 'assert_no_console_errors', allow: ['KNOWN NOISY'] }, dirtyCtx);
  check('allowlist match is case-insensitive', !caseInsensitiveAllow.ok && caseInsensitiveAllow.detail.includes('1 unallowed'));
}

// ---------------------------------------------------------------------------

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  console.error(`\n${failed.length} checks failed:`);
  for (const [label] of failed) console.error(` - ${label}`);
  process.exit(1);
}

console.log(`\nV42 assertion-vocabulary checks passed (${checks.length}).`);
