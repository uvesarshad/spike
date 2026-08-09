/* V39 - A9 (P1): verifyActionEffect intent-specific proof.
 *
 * The regression this fixes: verifyActionEffect() used to end with a
 * catch-all — `if (changes.length) return { ok: true, ... }` — where
 * `changes` came purely from a URL diff or a whole-page-signature diff. A
 * cached target re-resolves by role+name+nth against the live page, so a hit
 * cannot land on an arbitrary node, but it COULD land on a node that still
 * matches role+name+nth while no longer being the semantically same element
 * (a reordered/paginated list, a redesign recycling a label) — and that case
 * was accepted as "verified" if ANYTHING ELSE on the page changed (a toast,
 * an ad refresh, a live ticker, an unrelated nav). This suite proves that
 * case is now rejected, while every legitimate case (own-target change, URL
 * change, target disappearance, a genuine status/alert/dialog effect) still
 * passes.
 *
 * Run: npx tsx test/v39.action-cache-verify.ts
 */

import assert from 'node:assert/strict';
import type { Action } from '../src/driver/actions.js';
import type { AxNode, AxSnapshot } from '../src/ports/browser-port.js';
import type { StepTarget } from '../src/report/report.js';
import { pageSignatureFromAx, verifyActionEffect, type ActionEffectState } from '../src/cache/action-cache.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

function ax(root: AxNode): AxSnapshot {
  return { root, text: '', truncated: false };
}

function state(url: string, root: AxNode, capturedAt = 1000): ActionEffectState {
  const snapshot = ax(root);
  return {
    url,
    normalizedUrl: url,
    pageSignature: pageSignatureFromAx(snapshot),
    capturedAt,
    ax: snapshot,
  };
}

const URL = 'http://localhost:9401/list';

// ---------------------------------------------------------------------------
// 1. THE REGRESSION: click's own target is unchanged, but an unrelated
//    sibling (a plain heading — not a live-region role) mutates. Previously
//    a bare page-signature diff was "verified"; it must now be rejected.
// ---------------------------------------------------------------------------
{
  const deleteTarget: StepTarget = { role: 'button', name: 'Delete', nth: 2 };
  const before = state(URL, {
    id: 'root',
    role: 'RootWebArea',
    name: 'List',
    children: [
      { id: 'n1', role: 'heading', name: 'Row count: 5' },
      { id: 'n2', role: 'button', name: 'Delete' },
      { id: 'n3', role: 'button', name: 'Delete' },
      { id: 'n4', role: 'button', name: 'Delete' },
    ],
  });
  // Same shape, but the unrelated heading's text changed (e.g. an ad slot or
  // a live counter ticking) — the "Delete" nth=2 target itself is identical.
  const after = state(URL, {
    id: 'root',
    role: 'RootWebArea',
    name: 'List',
    children: [
      { id: 'n1', role: 'heading', name: 'Row count: 7' },
      { id: 'n2', role: 'button', name: 'Delete' },
      { id: 'n3', role: 'button', name: 'Delete' },
      { id: 'n4', role: 'button', name: 'Delete' },
    ],
  });
  const click: Action = { type: 'click', nodeId: 'n4' };
  const result = verifyActionEffect(before, after, click, deleteTarget);
  check('REGRESSION: click with unchanged target + unrelated page mutation is now REJECTED', !result.ok);
  check('regression case still reports the page-signature diff in changes[]', result.changes.includes('page-signature'));
}

// ---------------------------------------------------------------------------
// 2. Legitimate click cases must still be ACCEPTED.
// ---------------------------------------------------------------------------
{
  // 2a. Target's own state changes (e.g. a checkbox toggles).
  const target: StepTarget = { role: 'checkbox', name: 'Subscribe' };
  const before = state(URL, { id: 'root', role: 'RootWebArea', name: 'Form', children: [{ id: 'n1', role: 'checkbox', name: 'Subscribe', states: [] }] });
  const after = state(URL, { id: 'root', role: 'RootWebArea', name: 'Form', children: [{ id: 'n1', role: 'checkbox', name: 'Subscribe', states: ['checked'] }] });
  const result = verifyActionEffect(before, after, { type: 'click', nodeId: 'n1' }, target);
  check('legitimate: click that changes the target own state is accepted', result.ok);
}
{
  // 2b. URL changes (navigation link).
  const target: StepTarget = { role: 'link', name: 'Checkout' };
  const before = state(URL, { id: 'root', role: 'RootWebArea', name: 'Cart', children: [{ id: 'n1', role: 'link', name: 'Checkout' }] });
  const after = state('http://localhost:9401/checkout', { id: 'root', role: 'RootWebArea', name: 'Checkout', children: [] });
  const result = verifyActionEffect(before, after, { type: 'click', nodeId: 'n1' }, target);
  check('legitimate: click that changes the URL is accepted', result.ok);
}
{
  // 2c. Target disappears (row removed, dialog dismissed) — a legitimate outcome.
  const target: StepTarget = { role: 'button', name: 'Dismiss' };
  const before = state(URL, { id: 'root', role: 'RootWebArea', name: 'Page', children: [{ id: 'n1', role: 'button', name: 'Dismiss' }] });
  const after = state(URL, { id: 'root', role: 'RootWebArea', name: 'Page', children: [] });
  const result = verifyActionEffect(before, after, { type: 'click', nodeId: 'n1' }, target);
  check('legitimate: click whose target disappears is accepted', result.ok);
}
{
  // 2d. A genuine status/alert region appears in response to the click, target unchanged.
  const target: StepTarget = { role: 'button', name: 'Add to cart' };
  const before = state(URL, {
    id: 'root',
    role: 'RootWebArea',
    name: 'Product',
    children: [{ id: 'n1', role: 'button', name: 'Add to cart' }],
  });
  const after = state(URL, {
    id: 'root',
    role: 'RootWebArea',
    name: 'Product',
    children: [
      { id: 'n1', role: 'button', name: 'Add to cart' },
      { id: 'n2', role: 'status', name: 'Item added to cart' },
    ],
  });
  const result = verifyActionEffect(before, after, { type: 'click', nodeId: 'n1' }, target);
  check('legitimate: click that surfaces a new status/alert region is accepted', result.ok);
}

// ---------------------------------------------------------------------------
// 3. hover: signature-only is weak evidence and must be rejected; own-state
//    change or a tooltip/dialog region must be accepted.
// ---------------------------------------------------------------------------
{
  const target: StepTarget = { role: 'link', name: 'Info' };
  const before = state(URL, {
    id: 'root',
    role: 'RootWebArea',
    name: 'Page',
    children: [
      { id: 'n1', role: 'link', name: 'Info' },
      { id: 'n2', role: 'heading', name: 'Unrelated 1' },
    ],
  });
  const afterUnrelatedOnly = state(URL, {
    id: 'root',
    role: 'RootWebArea',
    name: 'Page',
    children: [
      { id: 'n1', role: 'link', name: 'Info' },
      { id: 'n2', role: 'heading', name: 'Unrelated 2' },
    ],
  });
  const rejected = verifyActionEffect(before, afterUnrelatedOnly, { type: 'hover', nodeId: 'n1' }, target);
  check('hover: page-signature-only change (no tooltip, no own-state change) is rejected', !rejected.ok);

  const afterTooltip = state(URL, {
    id: 'root',
    role: 'RootWebArea',
    name: 'Page',
    children: [
      { id: 'n1', role: 'link', name: 'Info' },
      { id: 'n2', role: 'heading', name: 'Unrelated 1' },
      { id: 'n3', role: 'tooltip', name: 'More info about this link' },
    ],
  });
  const accepted = verifyActionEffect(before, afterTooltip, { type: 'hover', nodeId: 'n1' }, target);
  check('hover: a revealed tooltip region is accepted', accepted.ok);

  const afterGone = state(URL, { id: 'root', role: 'RootWebArea', name: 'Page', children: [] });
  const staleTarget = verifyActionEffect(before, afterGone, { type: 'hover', nodeId: 'n1' }, target);
  check('hover: target no longer resolving is rejected', !staleTarget.ok);
}

// ---------------------------------------------------------------------------
// 4. type with a secret placeholder: an already-focused, already-populated
//    field with no value change must now be REJECTED (previously accepted on
//    "non-empty OR focused" alone).
// ---------------------------------------------------------------------------
{
  const target: StepTarget = { role: 'textbox', name: 'Password' };
  const before = state(URL, {
    id: 'root',
    role: 'RootWebArea',
    name: 'Login',
    children: [{ id: 'n1', role: 'textbox', name: 'Password', value: 'stale-old-value', states: ['focused'] }],
  });
  const afterNoChange = state(URL, {
    id: 'root',
    role: 'RootWebArea',
    name: 'Login',
    children: [{ id: 'n1', role: 'textbox', name: 'Password', value: 'stale-old-value', states: ['focused'] }],
  });
  const rejected = verifyActionEffect(
    before,
    afterNoChange,
    { type: 'type', nodeId: 'n1', text: '{{secret:PASSWORD}}' },
    target,
  );
  check('REGRESSION: secret type into already-focused/populated field with no change is REJECTED', !rejected.ok);

  const afterEmptyToFilled = state(URL, {
    id: 'root',
    role: 'RootWebArea',
    name: 'Login',
    children: [{ id: 'n1', role: 'textbox', name: 'Password', value: '', states: ['focused'] }],
  });
  const beforeEmpty = state(URL, {
    id: 'root',
    role: 'RootWebArea',
    name: 'Login',
    children: [{ id: 'n1', role: 'textbox', name: 'Password', value: '', states: [] }],
  });
  const afterFilled = state(URL, {
    id: 'root',
    role: 'RootWebArea',
    name: 'Login',
    children: [{ id: 'n1', role: 'textbox', name: 'Password', value: 'x'.repeat(12), states: ['focused'] }],
  });
  const accepted = verifyActionEffect(
    beforeEmpty,
    afterFilled,
    { type: 'type', nodeId: 'n1', text: '{{secret:PASSWORD}}' },
    target,
  );
  check('legitimate: secret type from previously-empty to populated is accepted', accepted.ok);
  void afterEmptyToFilled;
}

// ---------------------------------------------------------------------------
// 5. select_option: exact match preferred over substring; substring is a
//    fallback (and says so in the reason) when no exact match is possible.
// ---------------------------------------------------------------------------
{
  const target: StepTarget = { role: 'combobox', name: 'Country' };
  const before = state(URL, {
    id: 'root',
    role: 'RootWebArea',
    name: 'Form',
    children: [{ id: 'n1', role: 'combobox', name: 'Country', value: '' }],
  });
  const afterExact = state(URL, {
    id: 'root',
    role: 'RootWebArea',
    name: 'Form',
    children: [{ id: 'n1', role: 'combobox', name: 'Country', value: 'Canada' }],
  });
  const exact = verifyActionEffect(before, afterExact, { type: 'select_option', nodeId: 'n1', value: 'Canada' }, target);
  check('select_option: exact value match is accepted', exact.ok && !/substring/i.test(exact.reason));

  // No exact match possible (node text only contains the value as a substring
  // of a larger label), but a substring match exists — accepted, and the
  // reason names the fallback.
  const afterSubstringOnly = state(URL, {
    id: 'root',
    role: 'RootWebArea',
    name: 'Form',
    children: [{ id: 'n1', role: 'combobox', name: 'Country', value: 'Canada (French)' }],
  });
  const substring = verifyActionEffect(
    before,
    afterSubstringOnly,
    { type: 'select_option', nodeId: 'n1', value: 'Canada' },
    target,
  );
  check('select_option: substring fallback is accepted when no exact match exists', substring.ok);
  check('select_option: substring fallback names itself in the reason', /substring/i.test(substring.reason));

  const afterNoMatch = state(URL, {
    id: 'root',
    role: 'RootWebArea',
    name: 'Form',
    children: [{ id: 'n1', role: 'combobox', name: 'Country', value: 'Germany' }],
  });
  const noMatch = verifyActionEffect(before, afterNoMatch, { type: 'select_option', nodeId: 'n1', value: 'Canada' }, target);
  check('select_option: no match at all is rejected', !noMatch.ok);
}

// ---------------------------------------------------------------------------
// 6. navigate: a same-URL error page must be rejected even though the URL
//    matches the expectation.
// ---------------------------------------------------------------------------
{
  const before = state(URL, { id: 'root', role: 'RootWebArea', name: 'Before', children: [] });
  const afterOk = state('http://localhost:9401/checkout', {
    id: 'root',
    role: 'RootWebArea',
    name: 'Checkout',
    children: [{ id: 'n1', role: 'heading', name: 'Checkout' }],
  });
  const ok = verifyActionEffect(before, afterOk, { type: 'navigate', url: 'http://localhost:9401/checkout' });
  check('legitimate: navigate reaching the expected URL with a normal page is accepted', ok.ok);

  const afterErrorPage = state('http://localhost:9401/checkout', {
    id: 'root',
    role: 'RootWebArea',
    name: 'Error',
    children: [{ id: 'n1', role: 'heading', name: '500 Internal Server Error' }],
  });
  const rejected = verifyActionEffect(before, afterErrorPage, { type: 'navigate', url: 'http://localhost:9401/checkout' });
  check('REGRESSION: navigate reaching the right URL but an error page is REJECTED', !rejected.ok);
}

// ---------------------------------------------------------------------------
// 7. Previously-passing cases from the general-purpose paths must still work:
//    wait / assert_dom / extract / reload / go_back / press_key.
// ---------------------------------------------------------------------------
{
  const before = state(URL, { id: 'root', role: 'RootWebArea', name: 'Page', children: [] }, 1000);
  const after = state(URL, { id: 'root', role: 'RootWebArea', name: 'Page', children: [] }, 1510);
  const waitOk = verifyActionEffect(before, after, { type: 'wait', ms: 500 });
  check('wait: unchanged semantics still accepted', waitOk.ok);
}
{
  const before = state(URL, { id: 'root', role: 'RootWebArea', name: 'Page', children: [{ id: 'n1', role: 'status', name: 'Total: 0' }] });
  const after = state(URL, { id: 'root', role: 'RootWebArea', name: 'Page', children: [{ id: 'n1', role: 'status', name: 'Total: 3' }] });
  const assertOk = verifyActionEffect(before, after, { type: 'assert_dom', nodeId: 'n1', contains: 'Total: 3' });
  check('assert_dom: unchanged semantics still accepted', assertOk.ok);
  const assertFail = verifyActionEffect(before, after, { type: 'assert_dom', nodeId: 'n1', contains: 'Total: 9' });
  check('assert_dom: unchanged semantics still rejects a false condition', !assertFail.ok);
}
{
  const before = state(URL, { id: 'root', role: 'RootWebArea', name: 'Page', children: [{ id: 'n1', role: 'text', name: 'Order #4521' }] });
  const after = before;
  const extractOk = verifyActionEffect(before, after, { type: 'extract', nodeId: 'n1', key: 'orderId', pattern: '\\d+' });
  check('extract: unchanged semantics still accepted', extractOk.ok);
}
{
  // reload settling on the same URL.
  const before = state(URL, { id: 'root', role: 'RootWebArea', name: 'Page', children: [] });
  const after = state(URL, { id: 'root', role: 'RootWebArea', name: 'Page', children: [] });
  const reloadOk = verifyActionEffect(before, after, { type: 'reload' });
  check('reload: settling on the same URL is still accepted', reloadOk.ok);
}
{
  // go_back / press_key: a page-signature diff alone is still sufficient
  // (per-type "keep existing semantics", unlike click/hover).
  const before = state(URL, { id: 'root', role: 'RootWebArea', name: 'B', children: [{ id: 'n1', role: 'heading', name: 'B' }] });
  const after = state('http://localhost:9401/prev', { id: 'root', role: 'RootWebArea', name: 'A', children: [{ id: 'n1', role: 'heading', name: 'A' }] });
  const goBackOk = verifyActionEffect(before, after, { type: 'go_back' });
  check('go_back: unchanged semantics (URL/page-signature diff) still accepted', goBackOk.ok);

  const pressKeyOk = verifyActionEffect(before, after, { type: 'press_key', key: 'Enter' });
  check('press_key: unchanged semantics (URL/page-signature diff) still accepted', pressKeyOk.ok);

  const noopAfter = before;
  const goBackReject = verifyActionEffect(before, noopAfter, { type: 'go_back' });
  check('go_back: no observable change is rejected', !goBackReject.ok);
}

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  console.error(`\n${failed.length} checks failed:`);
  for (const [label] of failed) console.error(` - ${label}`);
  process.exit(1);
}

assert.equal(failed.length, 0);
console.log(`\nV39 action-cache verify checks passed (${checks.length}).`);
