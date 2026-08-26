/* v49 — A3 (P0) + A6/A7/A13 (P1): parallel isolated runs, storage-state
 * reuse, network interception/emulation, and headless Nano-splitting.
 *
 * `src/ports/playwright-browser.ts` (wave 3, A26 RESOLVED) already proved
 * per-context isolation, storageState()/setStorageState(), and route() work
 * over `connectOverCDP` against a real Chrome (see
 * docs/plan/26-08-08-audit-deterministic-speed.md and test/v45.playwright-
 * port.ts, which exercises that port directly). This suite wires it into
 * engine.ts/config.ts/cli.ts/nano-runner-page.ts/chrome/launch.ts and covers
 * the NEW plumbing:
 *
 *   A3 — parallel isolated runs:
 *     1. `allocateFreePort()` (chrome/launch.ts) mints distinct, genuinely
 *        bindable ports.
 *     2. `allocateIsolatedSession()` (engine.ts) mints a fully distinct
 *        {cdpPort, runnerPort, chromeProfile} triple per call — the "own
 *        profile dir when it must launch its own Chrome" primitive `replay
 *        --all --workers N` uses for the `via !== 'playwright'` case.
 *     3. the Nano runner's shared HTTP server is now refcounted
 *        (nano-runner-page.ts's `acquireRunnerServer`/`releaseRunnerServer`)
 *        instead of every `NanoRunnerPage.start()` unconditionally binding —
 *        the literal EADDRINUSE crash the audit names by finding number.
 *     4. `withNanoLock()` (nano-runner-page.ts) serializes concurrent
 *        Runtime.evaluate calls into ONE shared Nano tab per cdpPort, so two
 *        overlapping qaReplay calls (`via: 'playwright'` + `--workers N`,
 *        sharing one Chrome) can't interleave into the page's single
 *        Prompt-API session.
 *
 *   A7 — headless / Nano split:
 *     5. `resolveNanoLaunchOpts()` (engine.ts) — the full decision matrix:
 *        headless=false shares cfg.cdpPort/runnerPort/chromeProfile exactly
 *        as before this finding; headless=true splits Nano onto its own
 *        headed Chrome, either a pinned `nanoCdpPort` or a freshly allocated
 *        one, always its own profile dir (two Chromes can never share a
 *        --user-data-dir).
 *     6. `config.ts`: `headless` defaults false; `via` accepts 'playwright';
 *        `SPIKE_HEADLESS`/`SPIKE_NANO_CDP_PORT` env overrides.
 *
 *   A13 — network interception + emulation:
 *     7. `globToRegExp()` (engine.ts) — the CDP-glob-to-RegExp translation
 *        `applyRouteRules` dispatches `Fetch.requestPaused` events through.
 *     8. `config.ts`: `SPIKE_ROUTE_RULES` (JSON) / `SPIKE_BLOCK_HOSTS`
 *        (comma list) / `SPIKE_VIEWPORT` / `SPIKE_NETWORK_THROTTLE` env
 *        parsing into `routeRules`/`emulation`.
 *
 *   A6 — storage state:
 *     9. `saveStorageStateFile`/`loadStorageStateFile` (engine.ts) round-trip
 *        a captured session through disk, including directory creation.
 *
 * (A31, 2026-08-27): `ensureChrome()`'s concurrency dedupe test — the one
 * check in this finding's original scope that needs a REAL Chrome — has been
 * split out to `test/v49b.ensure-chrome.ts` and moved to
 * `scripts/run-tests.mjs`'s BROWSER_SUITES list, so this suite (v49) is now
 * entirely pure/in-memory and safe for the fast bucket (`npm test`) on a
 * machine with no Chrome installed at all. Everything below is pure/unit-
 * level: ephemeral `mkdtemp`/random ports only, no `ensureChrome`/`CdpBrowser`
 * launch of any kind.
 *
 * Run: npx tsx test/v49.parallel-session.ts
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { allocateFreePort } from '../src/chrome/launch.js';
import { loadConfig, type QaConfig } from '../src/config.js';
import {
  allocateIsolatedSession,
  globToRegExp,
  loadStorageStateFile,
  resolveNanoLaunchOpts,
  saveStorageStateFile,
  type StorageState,
} from '../src/engine.js';
import { acquireRunnerServer, releaseRunnerServer, withNanoLock } from '../src/ports/nano-runner-page.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Set env vars for the duration of `fn`, then restore whatever was there
 * before (including "was absent") — so env-driven config tests never leak
 * into each other or into a real user's shell. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function main(): Promise<void> {
  /* ===================== 1: allocateFreePort ===================== */
  console.log('=== v49 1/9: allocateFreePort (chrome/launch.ts) ===');
  {
    const p1 = await allocateFreePort();
    const p2 = await allocateFreePort();
    check('allocateFreePort returns a plausible TCP port', p1 > 0 && p1 < 65536 && p2 > 0 && p2 < 65536);
    check('allocateFreePort returns distinct ports across two calls', p1 !== p2);

    const srv = net.createServer();
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(p1, '127.0.0.1', () => resolve());
    });
    check('the allocated port is genuinely bindable immediately after allocation', srv.listening);
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }

  /* ===================== 2: config resolution (A7/A13 defaults + env) ===================== */
  console.log('=== v49 2/9: config.ts — headless/via/nanoCdpPort/routeRules/emulation ===');
  {
    const defaults = loadConfig({});
    check('headless defaults to false (backward compatible)', defaults.headless === false);
    check('routeRules defaults to an empty array', Array.isArray(defaults.routeRules) && defaults.routeRules.length === 0);
    check('emulation defaults to undefined', defaults.emulation === undefined);
    check('nanoCdpPort/nanoProfileDir default to undefined', defaults.nanoCdpPort === undefined && defaults.nanoProfileDir === undefined);
    check('via defaults to cdp', defaults.via === 'cdp');

    check('via accepts "playwright" as an explicit override', loadConfig({ via: 'playwright' }).via === 'playwright');

    await withEnv({ SPIKE_HEADLESS: '1' }, () => {
      check('SPIKE_HEADLESS=1 turns headless on', loadConfig({}).headless === true);
    });
    await withEnv({ SPIKE_HEADLESS: '0' }, () => {
      check('SPIKE_HEADLESS=0 keeps headless off', loadConfig({}).headless === false);
    });
    await withEnv({ SPIKE_HEADLESS: '1' }, () => {
      check('an explicit override still beats SPIKE_HEADLESS (override precedence unchanged)', loadConfig({ headless: false }).headless === false);
    });
    await withEnv({ SPIKE_NANO_CDP_PORT: '54321' }, () => {
      check('SPIKE_NANO_CDP_PORT is parsed as a number', loadConfig({}).nanoCdpPort === 54321);
    });

    await withEnv({ SPIKE_ROUTE_RULES: '[{"urlPattern":"*.png","action":"block"},{"urlPattern":"*/api/orders","action":"fail","status":500}]' }, () => {
      const rules = loadConfig({}).routeRules;
      check('SPIKE_ROUTE_RULES parses a JSON array of RouteRule', rules.length === 2 && rules[0].action === 'block' && rules[1].status === 500);
    });
    await withEnv({ SPIKE_ROUTE_RULES: 'not json {{{' }, () => {
      check('malformed SPIKE_ROUTE_RULES is ignored, not thrown (config load never crashes on bad env)', loadConfig({}).routeRules.length === 0);
    });
    await withEnv({ SPIKE_BLOCK_HOSTS: '*.doubleclick.net,*.googletagmanager.com' }, () => {
      const rules = loadConfig({}).routeRules;
      check('SPIKE_BLOCK_HOSTS folds in as convenience block rules', rules.length === 2 && rules.every((r) => r.action === 'block'));
    });
    await withEnv({ SPIKE_ROUTE_RULES: '[{"urlPattern":"*.png","action":"block"}]', SPIKE_BLOCK_HOSTS: '*.doubleclick.net' }, () => {
      check('SPIKE_ROUTE_RULES and SPIKE_BLOCK_HOSTS combine rather than one replacing the other', loadConfig({}).routeRules.length === 2);
    });

    await withEnv({ SPIKE_VIEWPORT: '1280x800' }, () => {
      check('SPIKE_VIEWPORT parses into emulation.viewport', loadConfig({}).emulation?.viewport?.width === 1280 && loadConfig({}).emulation?.viewport?.height === 800);
    });
    await withEnv({ SPIKE_NETWORK_THROTTLE: 'slow-3g' }, () => {
      check('SPIKE_NETWORK_THROTTLE parses a named preset', loadConfig({}).emulation?.networkThrottle === 'slow-3g');
    });
    await withEnv({ SPIKE_NETWORK_THROTTLE: 'not-a-real-preset' }, () => {
      check('an unrecognized SPIKE_NETWORK_THROTTLE value is ignored rather than accepted verbatim', loadConfig({}).emulation === undefined);
    });
  }

  /* ===================== 3: globToRegExp (A13 route-rule matching) ===================== */
  console.log('=== v49 3/9: globToRegExp — CDP-glob-to-RegExp translation ===');
  {
    const analytics = globToRegExp('*://*.doubleclick.net/*');
    check('block-pattern glob matches a real analytics URL', analytics.test('https://ads.doubleclick.net/pixel'));
    check('block-pattern glob does not match an unrelated host', !analytics.test('https://example.com/pixel'));

    const api = globToRegExp('*/api/orders');
    check('fail-pattern glob matches the exact tail it names', api.test('http://localhost:9401/api/orders'));
    check('fail-pattern glob does not match a DIFFERENT path', !api.test('http://localhost:9401/api/orders/123'));

    check('"?" means exactly one character (CDP glob semantics), not zero-or-more', globToRegExp('a?c').test('abc') && !globToRegExp('a?c').test('ac') && !globToRegExp('a?c').test('abbc'));

    // Escaping: a literal '.' in the pattern must NOT behave as regex "any character".
    const dotted = globToRegExp('*.example.com');
    check('a literal "." in the pattern is escaped, not treated as regex any-char', !dotted.test('fooXexampleYcom'));
    check('...while a genuine match still succeeds', dotted.test('www.example.com'));
  }

  /* ===================== 4: resolveNanoLaunchOpts (A7 headless/Nano split) ===================== */
  console.log('=== v49 4/9: resolveNanoLaunchOpts — where Nano attaches ===');
  {
    const shared = await resolveNanoLaunchOpts(loadConfig({ cdpPort: 5001, runnerPort: 5002, chromeProfile: '/tmp/spike-prof', headless: false }));
    check('headless=false: Nano shares cfg.cdpPort/runnerPort/chromeProfile (unchanged default behavior)', shared.cdpPort === 5001 && shared.runnerPort === 5002 && shared.profileDir === '/tmp/spike-prof');

    const pinned = await resolveNanoLaunchOpts(loadConfig({ cdpPort: 5001, runnerPort: 5002, chromeProfile: '/tmp/spike-prof', headless: true, nanoCdpPort: 6001 }));
    check('headless=true + pinned nanoCdpPort: uses the pin, keeps cfg.runnerPort, defaults the profile to "<profile>-nano"', pinned.cdpPort === 6001 && pinned.runnerPort === 5002 && pinned.profileDir === '/tmp/spike-prof-nano');

    const unpinned = await resolveNanoLaunchOpts(loadConfig({ cdpPort: 5001, runnerPort: 5002, chromeProfile: '/tmp/spike-prof', headless: true }));
    check('headless=true + unpinned: cdpPort is freshly allocated, distinct from the (headless) browser\'s own port', unpinned.cdpPort !== 5001);
    check('...and runnerPort is ALSO freshly allocated (avoids the shared-HTTP-server EADDRINUSE the audit names)', unpinned.runnerPort !== 5002);
    check('...and cdpPort/runnerPort are two distinct free ports, not the same one twice', unpinned.cdpPort !== unpinned.runnerPort);
    check('...and the profile dir still defaults to "<profile>-nano"', unpinned.profileDir === '/tmp/spike-prof-nano');

    const customProfile = await resolveNanoLaunchOpts(loadConfig({ cdpPort: 5001, runnerPort: 5002, chromeProfile: '/tmp/spike-prof', headless: true, nanoProfileDir: '/tmp/custom-nano-profile' }));
    check('an explicit nanoProfileDir overrides the "<profile>-nano" default', customProfile.profileDir === '/tmp/custom-nano-profile');
  }

  /* ===================== 5: storage-state file round-trip (A6) ===================== */
  console.log('=== v49 5/9: storage-state file round-trip ===');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v49-storage-'));
    const file = path.join(dir, 'nested', 'state.json'); // nested: proves mkdir -p
    const state: StorageState = {
      cookies: [{ name: 'sid', value: 'abc123', domain: 'localhost', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }],
      origins: [{ origin: 'http://localhost:9401', localStorage: [{ name: 'token', value: 'xyz' }] }],
    };
    saveStorageStateFile(file, state);
    check('saveStorageStateFile creates missing parent directories', fs.existsSync(file));
    const loaded = loadStorageStateFile(file);
    check('loadStorageStateFile round-trips cookies exactly', JSON.stringify(loaded.cookies) === JSON.stringify(state.cookies));
    check('loadStorageStateFile round-trips origins exactly', JSON.stringify(loaded.origins) === JSON.stringify(state.origins));
  }

  /* ===================== 6: allocateIsolatedSession (A3) ===================== */
  console.log('=== v49 6/9: allocateIsolatedSession — the expensive full-Chrome-per-call path ===');
  {
    const base = path.join(os.tmpdir(), 'v49-base-profile');
    const s1 = await allocateIsolatedSession(base);
    const s2 = await allocateIsolatedSession(base);
    check('two calls allocate distinct cdpPorts', s1.cdpPort !== s2.cdpPort);
    check('two calls allocate distinct runnerPorts', s1.runnerPort !== s2.runnerPort);
    check('cdpPort and runnerPort within ONE call are two different ports', s1.cdpPort !== s1.runnerPort);
    check('two calls mint distinct scratch profile dirs, both under "<base>-isolated"', s1.chromeProfile !== s2.chromeProfile && s1.chromeProfile.startsWith(`${base}-isolated`) && s2.chromeProfile.startsWith(`${base}-isolated`));
  }

  /* ===================== 7: Nano runner HTTP server refcounting (A3) ===================== */
  console.log('=== v49 7/9: NanoRunnerPage shared HTTP server refcounting ===');
  {
    const port = await allocateFreePort();
    const s1 = await acquireRunnerServer(port);
    const s2 = await acquireRunnerServer(port); // a "second NanoRunnerPage instance" on the SAME port
    check('a second acquire on the same port reuses the SAME http.Server (no second .listen(), no EADDRINUSE)', s1 === s2);

    const page1 = await fetch(`http://127.0.0.1:${port}/runner.html`).then((r) => r.text());
    check('the shared server actually serves runner.html', page1.length > 0);

    releaseRunnerServer(port); // refs 2 -> 1: must NOT close yet
    const page2 = await fetch(`http://127.0.0.1:${port}/runner.js`).then((r) => r.text());
    check('server still serves after ONE release while a second reference is still held', page2.length > 0);

    releaseRunnerServer(port); // refs 1 -> 0: now it must close
    await sleep(50);
    let closedAfterLastRelease = false;
    try {
      await fetch(`http://127.0.0.1:${port}/runner.html`, { signal: AbortSignal.timeout(500) });
    } catch {
      closedAfterLastRelease = true;
    }
    check('the server actually closes once the LAST reference releases (no leaked listener)', closedAfterLastRelease);
  }

  /* ===================== 8: withNanoLock serialization (A3) ===================== */
  console.log('=== v49 8/9: withNanoLock — serializing concurrent calls into one Nano tab ===');
  {
    const key = 949001;
    const events: string[] = [];
    const p1 = withNanoLock(key, async () => {
      events.push('start-1');
      await sleep(60);
      events.push('end-1');
      return 1;
    });
    const p2 = withNanoLock(key, async () => {
      events.push('start-2');
      await sleep(5);
      events.push('end-2');
      return 2;
    });
    const [r1, r2] = await Promise.all([p1, p2]);
    check('call 2 never starts before call 1 finishes (same lock key)', JSON.stringify(events) === JSON.stringify(['start-1', 'end-1', 'start-2', 'end-2']));
    check('each call still returns its OWN result, not the other\'s', r1 === 1 && r2 === 2);

    let p3Rejected = false;
    const p3 = withNanoLock(key, async () => {
      throw new Error('boom');
    });
    const p4 = withNanoLock(key, async () => 'ok-after-failure');
    await p3.catch(() => {
      p3Rejected = true;
    });
    const r4 = await p4;
    check('a REJECTING call does not wedge the lock for the next queued call on the same key', p3Rejected && r4 === 'ok-after-failure');

    const otherKey = 949002;
    const events2: string[] = [];
    const pA = withNanoLock(key, async () => {
      events2.push('A-start');
      await sleep(80);
      events2.push('A-end');
    });
    const pB = withNanoLock(otherKey, async () => {
      events2.push('B-start');
      await sleep(5);
      events2.push('B-end');
    });
    await Promise.all([pA, pB]);
    check('a DIFFERENT lock key (distinct cdpPort) runs independently, never waiting on an unrelated key\'s queue', events2.indexOf('B-end') < events2.indexOf('A-end'));
  }

  /* ===================== 9: QaConfig via/RouteRule/EmulationConfig types compile ===================== */
  console.log('=== v49 9/9: QaConfig surface — via/RouteRule/EmulationConfig ===');
  {
    // Purely a type + shape sanity check: a config object declaring every new
    // A13 field the way a suite's spike.config.json would resolves cleanly
    // through loadConfig() with no crash and no silent drop.
    const cfg: Partial<QaConfig> = {
      via: 'playwright',
      headless: true,
      routeRules: [
        { urlPattern: '*.png', action: 'block' },
        { urlPattern: '*/api/orders', action: 'fail', status: 500, body: '{"error":"forced"}' },
      ],
      emulation: { viewport: { width: 390, height: 844 }, isMobile: true, networkThrottle: 'fast-3g' },
    };
    const resolved = loadConfig(cfg);
    check('a suite-style config object round-trips via/headless/routeRules/emulation through loadConfig unchanged', resolved.via === 'playwright' && resolved.headless === true && resolved.routeRules.length === 2 && resolved.emulation?.isMobile === true);
  }

  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} v49 parallel-session checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
