/* V28 - verified step action cache (pure unit coverage, no Chrome/model calls).
 *
 * Covers the Phase 3 cache module:
 *  - normalized URL / goal / action / page-signature keying
 *  - file-backed persistence
 *  - no-secret storage rejection
 *  - cached target rehydration by role/name/nth
 *  - effect verification helpers for driver integration
 *  - exact hook notes exported for the future driver wire-up
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Action } from '../src/driver/actions.js';
import type { AxSnapshot } from '../src/ports/browser-port.js';
import type { StepTarget } from '../src/report/report.js';
import {
  ActionCacheRejectedError,
  FileActionCache,
  actionFromCachedValue,
  buildActionCacheKey,
  integrationHookNotes,
  normalizeUrlForActionCache,
  pageSignatureFromAx,
  toCachedActionValue,
  verifyActionEffect,
  type ActionEffectState,
} from '../src/cache/action-cache.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const axA: AxSnapshot = {
  truncated: false,
  text: '',
  root: {
    id: 'n0',
    role: 'RootWebArea',
    name: 'Fixture',
    children: [
      { id: 'n1', role: 'heading', name: 'Checkout' },
      { id: 'n2', role: 'button', name: 'Save' },
      { id: 'n3', role: 'button', name: 'Save' },
      { id: 'n4', role: 'textbox', name: 'Email', value: '' },
      { id: 'n5', role: 'button', name: 'Place order' },
    ],
  },
};

const axSameDifferentIds: AxSnapshot = {
  ...axA,
  root: {
    ...axA.root,
    id: 'n90',
    children: [
      { id: 'n91', role: 'heading', name: 'Checkout' },
      { id: 'n92', role: 'button', name: 'Save' },
      { id: 'n93', role: 'button', name: 'Save' },
      { id: 'n94', role: 'textbox', name: 'Email', value: '' },
      { id: 'n95', role: 'button', name: 'Place order' },
    ],
  },
};

const axTyped: AxSnapshot = {
  ...axA,
  root: {
    ...axA.root,
    children: [
      { id: 'n1', role: 'heading', name: 'Checkout' },
      { id: 'n2', role: 'button', name: 'Save' },
      { id: 'n3', role: 'button', name: 'Save' },
      { id: 'n4', role: 'textbox', name: 'Email', value: 'qa@example.test' },
      { id: 'n5', role: 'button', name: 'Place order' },
    ],
  },
};

const normalized = normalizeUrlForActionCache('HTTP://LOCALHOST:9401/shop/?utm_source=x&b=2&a=1#frag');
check('normalizes URL host/path/query and drops tracking params', normalized === 'http://localhost:9401/shop?a=1&b=2');

check('page signature ignores per-snapshot node ids', pageSignatureFromAx(axA) === pageSignatureFromAx(axSameDifferentIds));

const target: StepTarget = { role: 'button', name: 'Save', nth: 1, qaId: 'qa-save-2' };
const click: Action = { type: 'click', nodeId: 'n3' };
const key = buildActionCacheKey({
  url: 'http://localhost:9401/shop?utm_medium=email',
  goal: 'Checkout the cart',
  action: click,
  target,
  page: axA,
});
const sameKey = buildActionCacheKey({
  url: 'http://LOCALHOST:9401/shop/',
  goal: ' checkout   the CART ',
  action: click,
  target,
  page: axSameDifferentIds,
});
check('cache key is stable across URL/goal/id normalization', key.id === sameKey.id);

const changedGoalKey = buildActionCacheKey({
  url: 'http://localhost:9401/shop/',
  goal: 'Open account settings',
  action: click,
  target,
  page: axA,
});
check('cache key changes when normalized goal changes', key.id !== changedGoalKey.id);

const value = toCachedActionValue(click, target);
check('cached click stores locator target, not nodeId', value.type === 'click' && value.target.nth === 1 && !JSON.stringify(value).includes('n3'));

const rehydrated = await actionFromCachedValue(value, axA);
check('cached target rehydrates by role/name/nth', rehydrated?.type === 'click' && rehydrated.nodeId === 'n3');

const staleAx: AxSnapshot = { ...axA, root: { ...axA.root, children: [{ id: 'n1', role: 'heading', name: 'Checkout' }] } };
const stale = await actionFromCachedValue(value, staleAx);
check('stale cached target resolves to null for driver fallback', stale === null);

const typedValue = toCachedActionValue(
  { type: 'type', nodeId: 'n4', text: '{{secret:SHOP_PASSWORD}}' },
  { role: 'textbox', name: 'Password' },
);
check('secret placeholders may be stored for type actions', typedValue.type === 'type' && typedValue.text === '{{secret:SHOP_PASSWORD}}');

assert.throws(
  () => toCachedActionValue({ type: 'type', nodeId: 'n4', text: 'sk-1234567890abcdefghijklmnop' }, { role: 'textbox', name: 'API key' }),
  ActionCacheRejectedError,
);
check('raw secret-like type text is rejected', true);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-action-cache-'));
const cache = new FileActionCache(tmp);
const record = cache.put(key, value, { sourceRunId: 'r-test', sourceStepIndex: 2 });
const loaded = cache.read(key);
check('file cache writes and reads a record', loaded?.key.id === record.key.id && loaded.value.type === 'click');
check('file cache path is sharded by key hash', cache.getPath(key).includes(path.join(`v1`, key.id.slice(0, 2))));

const before: ActionEffectState = {
  url: 'http://localhost:9401/shop',
  normalizedUrl: 'http://localhost:9401/shop',
  pageSignature: pageSignatureFromAx(axA),
  capturedAt: 1000,
  ax: axA,
};
const afterTyped: ActionEffectState = {
  url: 'http://localhost:9401/shop',
  normalizedUrl: 'http://localhost:9401/shop',
  pageSignature: pageSignatureFromAx(axTyped),
  capturedAt: 1200,
  ax: axTyped,
};
const typedEffect = verifyActionEffect(before, afterTyped, { type: 'type', nodeId: 'n4', text: 'qa@example.test' }, { role: 'textbox', name: 'Email' });
check('effect verifier accepts visible type value change', typedEffect.ok && typedEffect.changes.includes('page-signature'));

const afterNoChange: ActionEffectState = { ...before, capturedAt: 1010 };
const noEffect = verifyActionEffect(before, afterNoChange, click, target);
check('effect verifier rejects stale hit with no observable effect', !noEffect.ok);

const waitEffect = verifyActionEffect(before, { ...before, capturedAt: 1510 }, { type: 'wait', ms: 500 });
check('effect verifier accepts wait duration', waitEffect.ok);

const hookNotes = integrationHookNotes();
check('integration notes include before-navigator hook', hookNotes.some((note) => note.includes('Before the navigator call in runDriverLoop')));
check('integration notes include stale fallback hook', hookNotes.some((note) => note.includes('fall back to navigateOnce()')));

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  console.error(`\n${failed.length} checks failed:`);
  for (const [label] of failed) console.error(` - ${label}`);
  process.exit(1);
}

console.log(`\nV28 action-cache checks passed (${checks.length}).`);
