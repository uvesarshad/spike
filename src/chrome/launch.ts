/* Chrome process management — lifted from the spike-proven helpers
 * (spikes/cdp-logpoint/spike-a-web.js): find chrome.exe, reuse a live CDP
 * instance if one already listens on our port, otherwise spawn detached so the
 * browser (and any downloaded Nano model session) outlives individual runs. */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import CDP from 'chrome-remote-interface';

/** A10 (P0): resolve the Chrome/Chromium executable to launch.
 *
 * Resolution order: `SPIKE_CHROME_PATH` env var → `chromePath` (threaded in
 * by a caller that already resolved `QaConfig.chromePath` / spike.config.json
 * — see src/config.ts) → the hardcoded per-OS candidate list below. The env
 * var always wins over a caller-supplied config value, matching this repo's
 * general "env beats config file" resolution order (config.ts's header
 * comment). Either override is validated to exist on disk so a typo fails
 * fast with a clear message instead of silently falling through to the
 * standard-locations throw (previously the only day-one failure mode for
 * any Linux/Chromium/Chrome-for-Testing user or non-default install path —
 * see docs/plan/26-08-27-audit-market-readiness.md A10).
 */
/** "Chromium support" enhancement (docs/plan/26-08-27-audit-market-readiness.md
 * Suggested Enhancements, after A10): branded Chrome candidates first, common
 * Chromium install paths as fallbacks BEHIND them — so a box with both
 * installed still launches branded Chrome (Nano/the Prompt API is
 * Chrome-only; see isChromiumPath() below and nano-runner-page.ts's
 * unavailableHint()), while a Chromium-only box can still launch and drive
 * at all instead of hard-failing with "chrome executable not found". Split
 * out to a pure function so it (and pickFirstExisting()) are unit-testable
 * without touching real system paths — see test/v64.chromium-candidates.ts. */
export function chromeCandidates(): string[] {
  return [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    // Chromium fallbacks — deliberately last.
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
}

/** First candidate that exists on disk, in priority order. Pure/testable —
 * no env, no SPIKE_CHROME_PATH override logic (that's findChrome()'s job). */
export function pickFirstExisting(candidates: string[]): string | undefined {
  return candidates.find((p) => p && fs.existsSync(p));
}

/** Best-effort: is `chromePath` a Chromium (not branded Chrome) executable?
 * Used post-launch to make the Nano "unavailable" hint accurate (Nano/the
 * Prompt API is Chrome-only) rather than generic — see
 * nano-runner-page.ts's unavailableHint(). Path-name heuristic only; a
 * custom SPIKE_CHROME_PATH override with an unconventional name won't be
 * caught, which is fine — this only sharpens a message, it never gates
 * behavior. */
export function isChromiumPath(chromePath: string): boolean {
  return /chromium/i.test(chromePath);
}

export function findChrome(chromePath?: string): string {
  const override = process.env.SPIKE_CHROME_PATH || chromePath;
  if (override) {
    if (!fs.existsSync(override)) {
      throw new Error(
        `Chrome path override not found: ${override}\n` +
          'Set the SPIKE_CHROME_PATH env var (or "chromePath" in spike.config.json) to a valid Chrome/Chromium executable path.',
      );
    }
    return override;
  }
  const found = pickFirstExisting(chromeCandidates());
  if (!found) {
    throw new Error(
      'chrome executable not found in standard locations. Set the SPIKE_CHROME_PATH env var ' +
        '(or "chromePath" in spike.config.json) to your Chrome executable path.',
    );
  }
  return found;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function cdpAlive(port: number): Promise<boolean> {
  try {
    await CDP.Version({ port });
    return true;
  } catch {
    return false;
  }
}

/** A3 (P0): bind to port 0 and read back the OS-assigned free port, for a
 * caller that needs to allocate its OWN Chrome (or Nano runner HTTP server)
 * instead of the fixed 9322/9400 defaults — e.g. two `spike replay --all
 * --workers 2` entries running fully-isolated Chrome processes, or a headless
 * run splitting Nano onto its own Chrome (A7). Small inherent TOCTOU race
 * (the port is free at the moment we check, not guaranteed free at the
 * moment the caller binds it) — the standard, accepted way to pick an
 * ephemeral port; a caller spawning Chrome moments later is exceedingly
 * unlikely to lose the race in practice, and `ensureChrome`'s own retry loop
 * below tolerates a slow bind either way. */
export function allocateFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      srv.close(() => {
        if (port) resolve(port);
        else reject(new Error('allocateFreePort: could not read the assigned port'));
      });
    });
  });
}

export interface LaunchOptions {
  port: number;
  profileDir: string;
  headless?: boolean;
  windowSize?: string; // "1366,960"
  /** A10 (P0): resolved `QaConfig.chromePath` override, if the caller has
   * one — threaded through to `findChrome()`. Optional: a caller that
   * hasn't wired config resolution through yet still gets the
   * `SPIKE_CHROME_PATH` env var (checked directly inside `findChrome`). */
  chromePath?: string;
}

/** A3 (P0): dedupe concurrent `ensureChrome()` calls for the SAME port within
 * this process. Without this, two near-simultaneous callers (e.g. two
 * `replay --all --workers N` entries both hitting a cold port at once) both
 * observe `cdpAlive(port) === false` and both `spawn()` a Chrome on the exact
 * same `--remote-debugging-port` — the loser's spawn either fails outright or
 * (worse) silently produces a second, orphaned Chrome process racing the
 * first for the port. Keyed by port so unrelated ports never block on each
 * other; the map entry is cleared once the launch settles (success or
 * failure) so a later cold-start on the same port (Chrome having since died)
 * isn't wedged behind a stale promise. */
const inFlightLaunches = new Map<number, Promise<void>>();

/** A29 (P1): does `pid` belong to a currently-running process? `process.kill`
 * with signal 0 sends no signal, just probes existence/permission. ESRCH
 * (or any other error besides EPERM) means it's gone; EPERM means it exists
 * but we lack permission to signal it (e.g. a different user) — still alive. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A29 (P1): detect a live Chromium "singleton" profile lock on `profileDir`
 * before we spawn a new Chrome into the same `--user-data-dir`. Chromium's
 * ProcessSingleton:
 *  - POSIX: `SingletonLock` is a symlink whose target is `<hostname>-<pid>`;
 *    `SingletonSocket` is the paired abstract/unix socket used for the
 *    actual handoff IPC (kept as a secondary signal since it isn't
 *    readable for a pid).
 *  - win32: instead holds a plain `lockfile` open with an exclusive lock
 *    (no readable pid) — treated as locked when we can't open it ourselves.
 * Returns `null` when unlocked, lock-holder is dead (stale lock — Chromium
 * cleans these up itself on next launch, nothing to do here), or detection
 * itself fails for any reason (permissions, exotic OS, TOCTOU race) — this
 * is a fail-fast UX improvement, not a safety guarantee, so any uncertainty
 * falls back to the pre-A29 behavior (spawn; let the port-poll loop decide). */
export function detectProfileLock(profileDir: string): { pid?: number } | null {
  try {
    if (process.platform === 'win32') {
      const lockPath = path.join(profileDir, 'lockfile');
      if (!fs.existsSync(lockPath)) return null;
      try {
        const fd = fs.openSync(lockPath, 'r+');
        fs.closeSync(fd);
        return null; // opened cleanly → nobody else holds it exclusively
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' ? {} : null;
      }
    }
    const target = fs.readlinkSync(path.join(profileDir, 'SingletonLock')); // throws if absent/not-a-symlink
    const match = /-(\d+)$/.exec(target);
    if (!match) {
      // Symlink exists but isn't in the expected "<host>-<pid>" shape —
      // fall back to the socket's mere existence as a locked signal.
      return fs.existsSync(path.join(profileDir, 'SingletonSocket')) ? {} : null;
    }
    const pid = Number(match[1]);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return isPidAlive(pid) ? { pid } : null;
  } catch {
    return null;
  }
}

/** Ensure a Chrome with CDP on `port` exists; reuse a live one, else spawn detached. */
export async function ensureChrome(opts: LaunchOptions): Promise<void> {
  if (await cdpAlive(opts.port)) return;
  const existing = inFlightLaunches.get(opts.port);
  if (existing) return existing;
  const launching = ensureChromeUncontended(opts).finally(() => {
    if (inFlightLaunches.get(opts.port) === launching) inFlightLaunches.delete(opts.port);
  });
  inFlightLaunches.set(opts.port, launching);
  return launching;
}

async function ensureChromeUncontended(opts: LaunchOptions): Promise<void> {
  // Re-check: another caller may have finished launching while this one was
  // queued behind the Map lookup above (the await in the caller's `if
  // (await cdpAlive(...))` check is itself a yield point).
  if (await cdpAlive(opts.port)) return;
  // A29 (P1): fail fast on a profile already locked by a LIVE Chrome
  // (e.g. the user's everyday Chrome pointed at the same --user-data-dir,
  // or a previous daemon process that's still alive under a different
  // CDP port) instead of spawning into it and burning the full ~15s
  // port-poll loop below only to time out with a generic error.
  const lock = detectProfileLock(opts.profileDir);
  if (lock) {
    const who = lock.pid ? ` by pid ${lock.pid}` : '';
    throw new Error(
      `Chrome profile ${opts.profileDir} is already in use${who} — close that Chrome or set SPIKE_CDP_PORT/profile`,
    );
  }
  const args = [
    `--remote-debugging-port=${opts.port}`,
    `--user-data-dir=${opts.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    // Without these, Windows occlusion tracking can throttle an unfocused/
    // covered window enough that CDP-dispatched clicks are swallowed during
    // long planner pauses (observed twice in live AI runs as no-op clicks).
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    `--window-size=${opts.windowSize ?? '1366,960'}`,
  ];
  if (opts.headless) args.push('--headless=new', '--disable-gpu');
  args.push('about:blank');
  const child = spawn(findChrome(opts.chromePath), args, { stdio: 'ignore', detached: true });
  child.unref();
  for (let i = 0; i < 50; i++) {
    if (await cdpAlive(opts.port)) return;
    await sleep(300);
  }
  throw new Error(`Chrome CDP port ${opts.port} never came up`);
}

export interface Tab {
  id: string;
  client: CDP.Client;
}

/** Open a new tab and return a connected CDP client with Page+Runtime enabled. */
export async function openTab(port: number, url: string): Promise<Tab> {
  const target = await CDP.New({ port, url });
  const id = (target as { id?: string; targetId?: string }).id ?? (target as { targetId?: string }).targetId!;
  const client = await CDP({ port, target: id });
  await Promise.all([client.Page.enable(), client.Runtime.enable()]);
  return { id, client };
}

export async function closeTab(port: number, tab: Tab): Promise<void> {
  try { await tab.client.close(); } catch { /* already closed */ }
  try { await CDP.Close({ port, id: tab.id }); } catch { /* already gone */ }
}

/** Evaluate an expression in a tab, awaiting promises, returning by value. */
export async function evalIn<T>(
  client: CDP.Client,
  expression: string,
  opts: { timeout?: number; userGesture?: boolean } = {},
): Promise<T> {
  const { result, exceptionDetails } = await client.Runtime.evaluate({
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: opts.timeout ?? 120_000,
    userGesture: opts.userGesture ?? true,
  });
  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description ?? JSON.stringify(exceptionDetails));
  }
  return result.value as T;
}
