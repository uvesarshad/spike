/* E6 — `spike login <url>`: a visible browser window opens on the address, the
 * person signs in any way they like (single sign-on, text-message code,
 * CAPTCHA), and Spike saves the session for later runs (`--storage-state`).
 * The browser and the "I'm done" signal are injected, so tests never start
 * Chrome; the real ones live at the bottom and are only built by the CLI. */

import os from 'node:os';
import path from 'node:path';
import { captureStorageState, saveStorageStateFile, type StorageState } from '../engine.js';

/** What `login` needs from a browser: open a page, read the session, shut down. */
export interface LoginBrowser {
  open(url: string): Promise<void>;
  capture(): Promise<StorageState>;
  close(): Promise<void>;
}

export interface LoginDeps {
  browser: LoginBrowser;
  /** Resolves when the person says they are signed in. */
  waitForDone: () => Promise<void>;
  save?: (file: string, state: StorageState) => void;
  progress?: (line: string) => void;
}

export interface LoginResult {
  file: string;
  cookies: number;
  sites: number;
}

export class LoginError extends Error {}

/** `<home>/.spike/sessions/<host>.json`, one saved sign-in per site. */
export function defaultSessionPath(url: string, homeDir: string = os.homedir()): string {
  let host: string;
  try { host = new URL(url).host; } catch { throw new LoginError(`"${url}" is not a web address (try https://example.com).`); }
  return path.join(homeDir, '.spike', 'sessions', `${host.replace(/[^a-z0-9.-]/gi, '_')}.json`);
}

export async function runLogin(url: string, file: string, deps: LoginDeps): Promise<LoginResult> {
  try { new URL(url); } catch { throw new LoginError(`"${url}" is not a web address (try https://example.com).`); }
  const say = deps.progress ?? (() => {});
  const save = deps.save ?? saveStorageStateFile;
  try {
    await deps.browser.open(url);
    say('A browser window is open. Sign in there, then come back here.');
    await deps.waitForDone();
    const state = await deps.browser.capture();
    if (!state.cookies.length && !state.origins.length) {
      throw new LoginError('Nothing to save yet — that window has no sign-in in it. Sign in first, then try again.');
    }
    save(file, state);
    return { file, cookies: state.cookies.length, sites: state.origins.length };
  } finally {
    try { await deps.browser.close(); } catch { /* window already gone */ }
  }
}

/** The real thing: a visible Chrome window over the same transport as runs. */
export async function createRealLoginBrowser(): Promise<LoginBrowser> {
  const { CdpBrowser } = await import('../ports/cdp-browser.js');
  const { loadConfig } = await import('../config.js');
  const cfg = loadConfig();
  const b = new CdpBrowser({ port: cfg.cdpPort, profileDir: cfg.chromeProfile, headless: false, chromePath: cfg.chromePath });
  return {
    async open(url) { await b.launch(); await b.navigate(url); },
    capture: () => captureStorageState(b),
    close: () => b.close(),
  };
}

/** Real "done" signal: the person presses Enter in the terminal. */
export function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
  });
}
