/* Chrome process management — lifted from the spike-proven helpers
 * (spikes/cdp-logpoint/spike-a-web.js): find chrome.exe, reuse a live CDP
 * instance if one already listens on our port, otherwise spawn detached so the
 * browser (and any downloaded Nano model session) outlives individual runs. */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import CDP from 'chrome-remote-interface';

export function findChrome(): string {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  const found = candidates.find((p) => p && fs.existsSync(p));
  if (!found) throw new Error('chrome executable not found in standard locations');
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
  const child = spawn(findChrome(), args, { stdio: 'ignore', detached: true });
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
