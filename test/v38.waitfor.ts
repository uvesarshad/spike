/* v38 — A4 (P0): auto-waiting primitives (waitForIdle / waitForActionable).
 *
 * The audit (docs/plan/26-08-08-audit-deterministic-speed.md, finding A4)
 * found ~20 hardcoded sleeps across cdp-browser.ts/replay.ts — simultaneously
 * the largest avoidable time cost (a 3-action batch burned ~1,150ms in fixed
 * sleeps alone) AND not enough on a slow page, which is where flake comes
 * from. The fix is `createNetworkIdleTracker()` (src/ports/browser-port.ts),
 * shared verbatim by CdpBrowser and ExtensionBrowser to back their
 * `waitForIdle()` implementations.
 *
 * This suite exercises the tracker directly with a fake CDP-shaped client —
 * the same convention as test/v36.client-errors.ts's fakeClient():
 * createNetworkIdleTracker only touches
 * client.Network.{requestWillBeSent,loadingFinished,loadingFailed}, so a real
 * chrome-remote-interface connection isn't needed. `waitForActionable` needs
 * a live DOM (Runtime.callFunctionOn on a resolved node) and is exercised for
 * real by the mandatory `npm run test:e2e` / `test/e2e.recorder.ts` gates,
 * which now route every CdpBrowser primitive through this same tracker.
 *
 * Covers:
 *  1. basic in-flight bookkeeping: request → count 1; finish → count 0
 *  2. loadingFailed also settles a request (not just loadingFinished)
 *  3. an UNMATCHED loadingFinished/loadingFailed (no prior requestWillBeSent —
 *     e.g. a request that started before the tracker attached, or a
 *     duplicate/out-of-order CDP event) is a harmless no-op: never drives the
 *     count negative, and bookkeeping still works correctly afterward
 *  4. multiple concurrent requests settle independently
 *  5. waitForIdle resolves once genuinely quiet, timed against a short custom
 *     quiet window
 *  6. waitForIdle NEVER rejects — a request that never finishes still
 *     resolves once timeoutMs elapses (the "give up and proceed" contract);
 *     the still-pending request remains counted afterward (not silently
 *     dropped by the timeout)
 *  7. default options (opts omitted entirely) don't throw and resolve well
 *     under the 5000ms default cap when the tracker was never active
 *
 * Run: npx tsx test/v38.waitfor.ts
 */

import type CDP from 'chrome-remote-interface';
import { createNetworkIdleTracker } from '../src/ports/browser-port.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

/* Minimal fake CDP client: createNetworkIdleTracker only touches
 * client.Network.{requestWillBeSent,loadingFinished,loadingFailed} — mirrors
 * v36.client-errors.ts's fakeClient() exactly, so a real chrome-remote-
 * interface connection isn't needed to exercise the bookkeeping. */
function fakeClient() {
  const handlers: Record<string, (payload: unknown) => void> = {};
  const client = {
    Network: {
      requestWillBeSent: (fn: (p: unknown) => void) => {
        handlers.requestWillBeSent = fn;
      },
      loadingFinished: (fn: (p: unknown) => void) => {
        handlers.loadingFinished = fn;
      },
      loadingFailed: (fn: (p: unknown) => void) => {
        handlers.loadingFailed = fn;
      },
    },
  };
  return { client: client as unknown as { Network: Pick<CDP.Client['Network'], 'requestWillBeSent' | 'loadingFinished' | 'loadingFailed'> }, handlers };
}

async function main() {
  // ---- 1: basic in-flight bookkeeping ----
  {
    const { client, handlers } = fakeClient();
    const tracker = createNetworkIdleTracker(client);
    check('starts with zero in-flight', tracker.inFlightCount() === 0);
    handlers.requestWillBeSent({ requestId: 'a' });
    check('requestWillBeSent increments the in-flight count', tracker.inFlightCount() === 1);
    handlers.loadingFinished({ requestId: 'a' });
    check('loadingFinished settles the matching request', tracker.inFlightCount() === 0);
  }

  // ---- 2: loadingFailed also settles (transport-level failure, not just success) ----
  {
    const { client, handlers } = fakeClient();
    const tracker = createNetworkIdleTracker(client);
    handlers.requestWillBeSent({ requestId: 'b' });
    handlers.loadingFailed({ requestId: 'b' });
    check('loadingFailed settles the matching request', tracker.inFlightCount() === 0);
  }

  // ---- 3: unmatched settle events are harmless no-ops, never go negative ----
  {
    const { client, handlers } = fakeClient();
    const tracker = createNetworkIdleTracker(client);
    handlers.loadingFinished({ requestId: 'never-started' });
    handlers.loadingFailed({ requestId: 'also-never-started' });
    check('an unmatched loadingFinished does not drive the count negative', tracker.inFlightCount() === 0);
    // Bookkeeping must not be left "poisoned" by the unmatched events above —
    // a real request afterward still counts and settles correctly.
    handlers.requestWillBeSent({ requestId: 'c' });
    check('a real request after unmatched settles still counts', tracker.inFlightCount() === 1);
    handlers.loadingFinished({ requestId: 'c' });
    check('...and still settles correctly', tracker.inFlightCount() === 0);
  }

  // ---- 4: multiple concurrent requests settle independently ----
  {
    const { client, handlers } = fakeClient();
    const tracker = createNetworkIdleTracker(client);
    handlers.requestWillBeSent({ requestId: 'x' });
    handlers.requestWillBeSent({ requestId: 'y' });
    check('two concurrent requests both count', tracker.inFlightCount() === 2);
    handlers.loadingFinished({ requestId: 'x' });
    check('one settling leaves the other in-flight', tracker.inFlightCount() === 1);
    handlers.loadingFailed({ requestId: 'y' });
    check('the second settling (via failure) reaches zero', tracker.inFlightCount() === 0);
  }

  // ---- 5: waitForIdle resolves once genuinely quiet, bounded by a short window ----
  {
    const { client } = fakeClient();
    const tracker = createNetworkIdleTracker(client);
    const t0 = Date.now();
    await tracker.waitForIdle({ networkQuietMs: 80, timeoutMs: 2000 });
    const elapsed = Date.now() - t0;
    // A never-active tracker still has to wait out the quiet window (there's
    // always a "prove nothing starts" period) — well under the 2s timeout,
    // but not instant either.
    check(`waitForIdle on an idle tracker resolves near the quiet window, not the timeout (${elapsed}ms)`, elapsed >= 40 && elapsed < 1000);
  }

  // ---- 6: waitForIdle NEVER rejects — gives up at timeoutMs and proceeds ----
  {
    const { client, handlers } = fakeClient();
    const tracker = createNetworkIdleTracker(client);
    handlers.requestWillBeSent({ requestId: 'stuck' }); // deliberately never settles
    const t0 = Date.now();
    let threw = false;
    try {
      await tracker.waitForIdle({ networkQuietMs: 50, timeoutMs: 150 });
    } catch {
      threw = true;
    }
    const elapsed = Date.now() - t0;
    check('waitForIdle resolves (does not reject) when the network never goes idle', !threw);
    check(`...and gives up around the timeoutMs bound, not sooner or hanging (${elapsed}ms)`, elapsed >= 140 && elapsed < 800);
    check('the stuck request is still counted in-flight after the timeout (not silently dropped)', tracker.inFlightCount() === 1);
  }

  // ---- 7: default options (opts omitted) don't throw, resolve well under the 5s cap ----
  {
    const { client } = fakeClient();
    const tracker = createNetworkIdleTracker(client);
    const t0 = Date.now();
    await tracker.waitForIdle(); // networkQuietMs=350, timeoutMs=5000 defaults
    const elapsed = Date.now() - t0;
    check(`waitForIdle() with no options resolves well under its 5000ms cap (${elapsed}ms)`, elapsed < 1500);
  }

  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} v38 waitfor checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
