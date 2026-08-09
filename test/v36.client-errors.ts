/* v36 — A18: 4xx responses were invisible to the failure signal.
 *
 * `NetworkEntry.failed` (src/capture/console-network.ts) is deliberately kept
 * 5xx/transport-only, because it also drives loop.ts's hard-stop logic
 * (drainHasPageError, the batch-abort check) — widening it to 4xx would
 * change run outcomes outside this fix's scope (a 401 auth probe or a
 * missing-favicon 404 is routine, not proof of a broken flow). Instead a
 * separate `clientError` signal (4xx, non-fatal) rides alongside it, and
 * planner-prompt.ts's networkLines now surfaces both — labeled distinctly —
 * instead of filtering 4xx out entirely.
 *
 * Covers:
 *   1. a 404 response sets clientError, not failed
 *   2. a 500 response still sets failed, not clientError
 *   3. a transport-level loadingFailed still sets failed (no status at all)
 *   4. firstError() prioritises a 5xx/transport failure over a 4xx
 *   5. firstError() falls back to a 4xx when it's the only signal present
 *   6. networkLines includes 4xx entries, labeled distinctly from 5xx, with
 *      the URL preserved so the model can judge first- vs third-party itself
 *   7. networkLines still respects the existing MAX_EVIDENCE_LINES cap */

import type CDP from 'chrome-remote-interface';
import { attachCapture, firstError } from '../src/capture/console-network.js';
import { networkLines, MAX_EVIDENCE_LINES } from '../src/driver/planner-prompt.js';
import type { NetworkEntry } from '../src/ports/browser-port.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

/* Minimal fake CDP client: attachCapture only touches Network.enable and the
 * five event-subscription methods it wires handlers onto, so a real
 * chrome-remote-interface connection isn't needed to exercise the capture
 * logic end-to-end (requestWillBeSent -> responseReceived/loadingFailed). */
function fakeClient() {
  const handlers: Record<string, (payload: unknown) => void> = {};
  const client = {
    Network: {
      enable: async () => {},
      requestWillBeSent: (fn: (p: unknown) => void) => {
        handlers.requestWillBeSent = fn;
      },
      responseReceived: (fn: (p: unknown) => void) => {
        handlers.responseReceived = fn;
      },
      loadingFailed: (fn: (p: unknown) => void) => {
        handlers.loadingFailed = fn;
      },
    },
    Runtime: {
      consoleAPICalled: () => {},
      exceptionThrown: () => {},
    },
  };
  return { client: client as unknown as CDP.Client, handlers };
}

async function main() {
  // ---- 1 & 2: responseReceived sets clientError XOR failed by status class ----
  {
    const { client, handlers } = fakeClient();
    const buffers = await attachCapture(client);

    handlers.requestWillBeSent({ requestId: 'r1', request: { method: 'GET', url: 'https://api.example.com/orders' } });
    handlers.responseReceived({ requestId: 'r1', response: { status: 404 } });

    handlers.requestWillBeSent({ requestId: 'r2', request: { method: 'POST', url: 'https://api.example.com/checkout' } });
    handlers.responseReceived({ requestId: 'r2', response: { status: 500 } });

    const network = buffers.drainNetwork();
    const notFound = network.find((e) => e.url.endsWith('/orders'));
    const serverError = network.find((e) => e.url.endsWith('/checkout'));

    check('404 sets clientError', notFound?.clientError === true);
    check('404 does NOT set failed', notFound?.failed === false);
    check('500 sets failed', serverError?.failed === true);
    check('500 does NOT set clientError', serverError?.clientError === false);
  }

  // ---- 3: transport-level loadingFailed still sets failed, no clientError ----
  {
    const { client, handlers } = fakeClient();
    const buffers = await attachCapture(client);

    handlers.requestWillBeSent({ requestId: 'r3', request: { method: 'GET', url: 'https://api.example.com/flaky' } });
    handlers.loadingFailed({ requestId: 'r3', errorText: 'net::ERR_CONNECTION_RESET' });

    const network = buffers.drainNetwork();
    const transportFail = network.find((e) => e.url.endsWith('/flaky'));

    check('transport failure sets failed', transportFail?.failed === true);
    check('transport failure has no status and no clientError', transportFail?.status === undefined && !transportFail?.clientError);
  }

  // ---- 4: firstError prioritises 5xx/transport over 4xx ----
  {
    const network: NetworkEntry[] = [
      { ts: 1, method: 'GET', url: 'https://api.example.com/probe', status: 401, failed: false, clientError: true },
      { ts: 2, method: 'POST', url: 'https://api.example.com/submit', status: 500, failed: true, clientError: false },
    ];
    const err = firstError([], network);
    check('firstError prefers the 5xx over an earlier-drained 4xx', err === '[NET-FAIL] POST https://api.example.com/submit → 500');
  }

  // ---- 5: firstError falls back to a 4xx when nothing more severe exists ----
  {
    const network: NetworkEntry[] = [
      { ts: 1, method: 'GET', url: 'https://api.example.com/orders', status: 404, failed: false, clientError: true },
    ];
    const err = firstError([], network);
    check('firstError surfaces a lone 4xx', err === '[NET-4XX] GET https://api.example.com/orders → 404');
  }

  {
    // No console/network evidence at all → still undefined (contract unchanged).
    const err = firstError([], []);
    check('firstError returns undefined with no evidence', err === undefined);
  }

  // ---- 6: networkLines shows 4xx and 5xx, labeled distinctly, URL included ----
  {
    const entries: NetworkEntry[] = [
      { ts: 1, method: 'GET', url: 'https://api.example.com/missing', status: 404, failed: false, clientError: true },
      { ts: 2, method: 'POST', url: 'https://api.example.com/broken', status: 503, failed: true, clientError: false },
      { ts: 3, method: 'GET', url: 'https://cdn.example.com/ok.png', status: 200, failed: false, clientError: false },
    ];
    const lines = networkLines(entries as unknown as NetworkEntry[]);

    check('networkLines drops healthy 2xx entries', lines.length === 2);
    check(
      'networkLines includes the 4xx entry with a distinct label and its URL',
      lines.some((l) => l.startsWith('net[4xx]:') && l.includes('https://api.example.com/missing') && l.includes('404')),
    );
    check(
      'networkLines includes the 5xx entry with the original label and its URL',
      lines.some((l) => l.startsWith('net:') && !l.startsWith('net[4xx]:') && l.includes('https://api.example.com/broken') && l.includes('503')),
    );
  }

  // ---- 7: the existing MAX_EVIDENCE_LINES cap still applies with 4xx mixed in ----
  {
    const many: NetworkEntry[] = Array.from({ length: MAX_EVIDENCE_LINES + 5 }, (_, i) => ({
      ts: i,
      method: 'GET',
      url: `https://api.example.com/item-${i}`,
      status: i % 2 === 0 ? 404 : 500,
      failed: i % 2 !== 0,
      clientError: i % 2 === 0,
    }));
    const lines = networkLines(many as unknown as NetworkEntry[]);

    check('networkLines caps at MAX_EVIDENCE_LINES even with 4xx entries mixed in', lines.length === MAX_EVIDENCE_LINES);
    check('the cap keeps the most recent entries (tail slice)', lines.at(-1)?.includes(`item-${MAX_EVIDENCE_LINES + 4}`) === true);
  }

  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} v36 client-error checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
