/* v60 — A45 (P2): allowed-host matching is exact-host-or-www ONLY by default;
 * a `.`-prefixed entry opts into subdomain-suffix matching. No AI, no Chrome —
 * pure function checks against src/ports/browser-port.ts's isHostAllowed().
 *
 *  Run: npx tsx test/v60.host-matching.ts   (exits nonzero on any failed check)
 */

import { isHostAllowed } from '../src/ports/browser-port.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

console.log('=== v60: A45 allowed-host matching ===');

check('exact host matches', isHostAllowed('example.com', ['example.com']));
check('www. sibling of a bare entry matches', isHostAllowed('www.example.com', ['example.com']));
check('bare host matches when the entry itself is www.', isHostAllowed('example.com', ['www.example.com']));
check(
  'a bare entry no longer matches an arbitrary subdomain (A45 fix)',
  !isHostAllowed('evil.example.com', ['example.com']),
);
check('a bare entry does not match a deeper www subdomain', !isHostAllowed('www.evil.example.com', ['example.com']));
check(
  'a "." prefixed entry DOES opt into subdomain-suffix matching',
  isHostAllowed('evil.example.com', ['.example.com']),
);
check('a "." prefixed entry still matches the bare apex too', isHostAllowed('example.com', ['.example.com']));
check('a "." prefixed entry matches www. as a subdomain form', isHostAllowed('www.example.com', ['.example.com']));
check('unrelated host does not match', !isHostAllowed('other.com', ['example.com']));
check('case-insensitive', isHostAllowed('EXAMPLE.com', ['example.COM']));
check('localhost still matches itself exactly', isHostAllowed('localhost', ['localhost']));
check('127.0.0.1 exact match', isHostAllowed('127.0.0.1', ['127.0.0.1']));

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v60 checks passed`);
process.exit(failed.length ? 1 : 0);
