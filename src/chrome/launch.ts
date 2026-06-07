/* Chrome process management — lifted from the spike-proven helpers
 * (spikes/cdp-logpoint/spike-a-web.js): find chrome.exe, reuse a live CDP
 * instance if one already listens on our port, otherwise spawn detached so the
 * browser (and any downloaded Nano model session) outlives individual runs. */

import fs from 'node:fs';
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

export interface LaunchOptions {
  port: number;
  profileDir: string;
  headless?: boolean;
  windowSize?: string; // "1366,960"
}

/** Ensure a Chrome with CDP on `port` exists; reuse a live one, else spawn detached. */
export async function ensureChrome(opts: LaunchOptions): Promise<void> {
  if (await cdpAlive(opts.port)) return;
  const args = [
    `--remote-debugging-port=${opts.port}`,
    `--user-data-dir=${opts.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
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
