/* v90 — A17 (P1): the deterministic page checks must work when the test is
 * driven from inside the browser, not just from a direct connection.
 *
 * Only the direct-connection transport ran the in-page probe, so testing from
 * inside the browser silently lost every DOM-level check — rendered
 * undefined/NaN, broken images, duplicate ids, an empty main region — and fell
 * back to console/network evidence alone. Same run, same page, two different
 * standards of proof depending on how the browser was reached.
 *
 * Covers (pure — no Chrome, no debugger, no network: the browser's debugging
 * channel is replaced by a recording stub):
 *   1. the in-browser transport now offers the checks at all;
 *   2. it dispatches the ONE compile-time probe — byte-for-byte the same script
 *      the direct connection sends — and asks for the value back, not a handle;
 *   3. whatever the page returns is handed back untouched, so the defensive
 *      parser stays the single place that interprets it;
 *   4. a page that refuses to be inspected surfaces as a thrown error the
 *      driver already swallows, never as a fabricated clean result;
 *   5. the daemon-driven in-browser transport offers the same method.
 *
 * Run: npx tsx test/v90.in-browser-page-checks.ts   (exits nonzero on any failed check)
 */

import { LiteExtensionBrowser } from '../src/extension/lite-extension-browser.js';
import { ExtensionBrowser } from '../src/ports/extension-browser.js';
import { INVARIANT_PROBE_JS, checkProbeInvariants } from '../src/assertions/invariants.js';
import type { CdpTransport } from '../src/bridge/cdp-shim.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

/** Stands in for the browser's own debugging channel (chrome.debugger.sendCommand
 * in the service worker). Records every command and answers Runtime.evaluate
 * with whatever the test wants the page to have returned. */
function stubTransport(evaluateResult: () => unknown): {
  transport: CdpTransport;
  sent: { method: string; params: Record<string, unknown> }[];
} {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const transport: CdpTransport = {
    async send(method, params) {
      sent.push({ method, params });
      if (method === 'Runtime.evaluate') return { result: { value: evaluateResult() } };
      return {};
    },
    subscribe() {
      return () => {};
    },
  };
  return { transport, sent };
}

/** The shape a real page's probe returns. */
const PAGE_RESULT = {
  renderedUndefined: ['Total: undefined'],
  brokenImages: ['/img/hero.png'],
  overflow: null,
  landmarks: {},
  stuckLoading: [],
  duplicateIds: [{ id: 'submit', count: 3 }],
};

function liteBrowser(transport: CdpTransport): LiteExtensionBrowser {
  return new LiteExtensionBrowser({
    transport,
    async navigate() {},
    async getUrl() {
      return 'https://shop.example.com/checkout';
    },
    async detach() {},
    onCursor() {},
  });
}

console.log('=== v90 1/3: the in-browser transport runs the page checks ===');
{
  const { transport, sent } = stubTransport(() => PAGE_RESULT);
  const browser = liteBrowser(transport);
  await browser.launch();

  check('the in-browser transport offers the page checks at all', typeof browser.probeInvariants === 'function');

  sent.length = 0;
  const raw = await browser.probeInvariants();

  const evals = sent.filter((c) => c.method === 'Runtime.evaluate');
  check('exactly one script is dispatched', evals.length === 1);
  check('it is the one built-in probe, unaltered', evals[0]?.params.expression === INVARIANT_PROBE_JS);
  check('the value is asked for by value, not as a handle', evals[0]?.params.returnByValue === true);
  check('it does not wait on a promise the page controls', evals[0]?.params.awaitPromise === false);
  check('the page result is handed back untouched', JSON.stringify(raw) === JSON.stringify(PAGE_RESULT));

  // …and the untouched result really is what the shared parser expects.
  const violations = checkProbeInvariants(raw);
  check('the shared parser turns it into findings', violations.some((v) => v.rule === 'rendered-undefined') && violations.some((v) => v.rule === 'broken-image'));
  check('a duplicate id on the page is among them', violations.some((v) => v.rule === 'duplicate-ids'));
}

console.log('\n=== v90 2/3: a page that refuses inspection ===');
{
  const { transport } = stubTransport(() => {
    throw new Error('Cannot access contents of the page');
  });
  const browser = liteBrowser(transport);
  await browser.launch();

  let threw = false;
  try {
    await browser.probeInvariants();
  } catch {
    threw = true;
  }
  check('a refused page throws rather than reporting a clean bill of health', threw);
}

console.log('\n=== v90 3/3: the daemon-driven in-browser transport too ===');
{
  check(
    'it offers the same page checks',
    typeof (ExtensionBrowser.prototype as { probeInvariants?: unknown }).probeInvariants === 'function',
  );
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) process.exit(1);
