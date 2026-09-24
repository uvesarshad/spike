/** A13/A16 — try-controls deny list, health-scan wording, transport-aware cap note. */
import assert from 'node:assert/strict';
import { filterSafeControls, pressedForbiddenControl, tryControlsInstruction } from '../src/discovery/try-controls.js';
import { renderCheckSummary, LITE_CAP_NOTE } from '../src/discovery/site-check.js';

const controls = [
  { label: 'Add to wishlist' }, { label: 'Buy now' }, { label: 'Place order' }, { label: 'Delete account' },
  { label: 'Log out' }, { label: 'Sign out' }, { label: 'Send message' }, { label: 'Open menu' },
  { label: 'Subscribe' }, { label: 'Unsubscribe' }, { label: 'Save', formFields: ['Email', 'Password'] },
  { label: 'Pay', formFields: ['Card number'] }, { label: 'Save', formFields: ['Nickname'] },
];
assert.deepEqual(filterSafeControls(controls).map((c) => c.label + (c.formFields ? '*' : '')), ['Add to wishlist', 'Open menu', 'Subscribe', 'Save*']);
assert.ok(pressedForbiddenControl([{ action: { type: 'click' }, target: { name: 'Delete' } }]));
assert.ok(!pressedForbiddenControl([{ action: { type: 'click' }, target: { name: 'Menu' } }]));
assert.match(tryControlsInstruction('http://x/'), /password or payment/);

const term = renderCheckSummary({ pagesChecked: 20, controlsFound: 5, problems: 0, capped: true, transport: 'terminal', maxPages: 20 });
assert.match(term, /Stopped after 20 pages — raise it with --max-pages/);
assert.ok(!term.includes('desktop helper'));
assert.ok(renderCheckSummary({ pagesChecked: 10, controlsFound: 5, problems: 0, capped: true }).includes(LITE_CAP_NOTE));
const look = renderCheckSummary({ pagesChecked: 4, controlsFound: 9, problems: 0, transport: 'terminal', looked: true });
assert.match(look, /without clicking anything/);
assert.match(look, /--try-controls/);
console.log('PASS v151 try-controls');
