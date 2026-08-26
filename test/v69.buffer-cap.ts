/* v69 — A49 (P2), part (c): capture buffers stay bounded during a long wait.
 *
 * A single navigator/brain LLM call can run for up to LLM_CALL_TIMEOUT_MS
 * before its step boundary finally drains console/network — a page spewing
 * console noise or firing requests the whole time would otherwise grow those
 * arrays unboundedly for the entire wait. attachCapture() (src/capture/
 * console-network.ts) now caps each buffer, dropping the OLDEST entries and
 * replacing them with one synthetic marker so truncation is visible evidence,
 * not a silent gap.
 *
 * Covers:
 *   1. pushing well past the cap converges to a stable, bounded length
 *   2. the newest entries survive (oldest are what's dropped)
 *   3. a truncation marker appears once the cap is exceeded
 *   4. network buffer gets the same treatment
 *   5. staying under the cap never truncates anything
 */

import type CDP from 'chrome-remote-interface';
import { attachCapture } from '../src/capture/console-network.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

/* Minimal fake CDP client — same shape v36.client-errors.ts already uses. */
function fakeClient() {
  const handlers: Record<string, (payload: unknown) => void> = {};
  const client = {
    Network: {
      enable: async () => {},
      requestWillBeSent: (fn: (p: unknown) => void) => { handlers.requestWillBeSent = fn; },
      responseReceived: (fn: (p: unknown) => void) => { handlers.responseReceived = fn; },
      loadingFailed: (fn: (p: unknown) => void) => { handlers.loadingFailed = fn; },
    },
    Runtime: {
      consoleAPICalled: (fn: (p: unknown) => void) => { handlers.consoleAPICalled = fn; },
      exceptionThrown: (fn: (p: unknown) => void) => { handlers.exceptionThrown = fn; },
    },
  };
  return { client: client as unknown as CDP.Client, handlers };
}

async function main() {
  // ---- 1, 2, 3: console buffer stays bounded, newest survive, marker appears ----
  {
    const { client, handlers } = fakeClient();
    const buffers = await attachCapture(client);

    const PUSHED = 2000; // well past the 500-entry cap
    for (let i = 0; i < PUSHED; i++) {
      handlers.consoleAPICalled({ type: 'log', args: [{ value: `line-${i}` }] });
    }

    const console_ = buffers.drainConsole();
    check('console buffer converged to a small, stable length (not 2000)', console_.length < 600);
    check('the newest entry survived', console_[console_.length - 1]?.text === `line-${PUSHED - 1}`);
    check('a truncation marker is present', console_.some((e) => e.text.includes('[CAPTURE-TRUNCATED]')));
    check('the earliest entries (line-0) were dropped, not kept', !console_.some((e) => e.text === 'line-0'));
  }

  // ---- 4: network buffer gets the same treatment ----
  {
    const { client, handlers } = fakeClient();
    const buffers = await attachCapture(client);

    const PUSHED = 2000;
    for (let i = 0; i < PUSHED; i++) {
      handlers.requestWillBeSent({ requestId: `r${i}`, request: { method: 'GET', url: `https://api.example.com/${i}` } });
      handlers.responseReceived({ requestId: `r${i}`, response: { status: 200 } });
    }

    const network = buffers.drainNetwork();
    check('network buffer converged to a small, stable length (not 2000)', network.length < 600);
    check('the newest network entry survived', network[network.length - 1]?.url === `https://api.example.com/${PUSHED - 1}`);
    check('a network truncation marker is present', network.some((e) => e.errorText?.includes('dropped')));
  }

  // ---- 5: staying under the cap never truncates ----
  {
    const { client, handlers } = fakeClient();
    const buffers = await attachCapture(client);

    for (let i = 0; i < 10; i++) {
      handlers.consoleAPICalled({ type: 'log', args: [{ value: `line-${i}` }] });
    }
    const console_ = buffers.drainConsole();
    check('under the cap: no truncation, all 10 entries present', console_.length === 10);
    check('under the cap: no marker text anywhere', !console_.some((e) => e.text.includes('TRUNCATED')));
  }

  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} v69 checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main();
