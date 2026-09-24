/* A6: wait for the page to actually change before re-testing a fix.
 *
 * Re-testing straight after the coding agent returns is right only for a
 * hot-reloading local dev server; against anything that rebuilds or deploys it
 * re-tests the OLD code and reports the fix failed. So: fingerprint the target
 * before the fix (status + hash of the HTML + hashes of the same-origin
 * script/style files it references), then after the agent returns —
 *   - localhost / 127.0.0.1 / [::1]: wait a short grace (hot reload) and go;
 *   - anything else: poll until the fingerprint differs, up to a timeout;
 *   - an explicit waitForUrl overrides both: poll until it answers 200.
 * On timeout the caller re-tests anyway and says the result may be stale.
 * Fetch and sleep are injected so this is testable with no network or clock. */

import crypto from 'node:crypto';

export type FetchLike = (url: string) => Promise<{ status: number; text(): Promise<string> }>;

export const DEFAULT_GRACE_MS = 3_000;
export const DEFAULT_POLL_MS = 3_000;
export const DEFAULT_REBUILD_TIMEOUT_MS = 180_000;
export const UNCONFIRMED_REBUILD_NOTE =
  "couldn't confirm the page rebuilt — this result may be for the old version";

const MAX_ASSETS = 20;
const sha = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

export function isLocalTarget(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost');
  } catch {
    return false;
  }
}

/** Same-origin <script src> and <link rel=stylesheet href> URLs in the markup. */
export function referencedAssets(html: string, pageUrl: string): string[] {
  const out = new Set<string>();
  let origin: string;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return [];
  }
  const add = (raw: string) => {
    try {
      const u = new URL(raw, pageUrl);
      if (u.origin === origin) out.add(u.toString());
    } catch {
      /* not a URL */
    }
  };
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/rel\s*=\s*["']?stylesheet/i.test(m[0])) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(m[0]);
    if (href) add(href[1]);
  }
  return [...out].slice(0, MAX_ASSETS);
}

/** A stable string for "what the page currently is", or null when it cannot be
 * fetched (a deploy mid-flight) — null is "no signal", never a change. */
export async function fingerprintTarget(url: string, fetchFn: FetchLike): Promise<string | null> {
  try {
    const res = await fetchFn(url);
    const html = await res.text();
    const parts = [`status:${res.status}`, `html:${sha(html)}`];
    for (const asset of referencedAssets(html, url)) {
      try {
        const a = await fetchFn(asset);
        parts.push(`${asset}:${a.status}:${sha(await a.text())}`);
      } catch {
        parts.push(`${asset}:unreachable`);
      }
    }
    return parts.join('|');
  } catch {
    return null;
  }
}

export interface RebuildWaitOptions {
  fetchFn?: FetchLike;
  sleepFn?: (ms: number) => Promise<void>;
  nowFn?: () => number;
  graceMs?: number;
  pollMs?: number;
  timeoutMs?: number;
  /** Poll this address until it answers 200 instead of comparing fingerprints. */
  waitForUrl?: string;
  onProgress?: (line: string) => void;
}

export const realFetch: FetchLike = async (url) => {
  const res = await fetch(url, { redirect: 'follow' });
  return { status: res.status, text: () => res.text() };
};
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Capture the fingerprint to compare against later. Only worth fetching when
 * the wait will actually use it (a remote target with no waitForUrl). */
export async function captureBeforeFix(url: string, opts: RebuildWaitOptions = {}): Promise<string | null> {
  if (opts.waitForUrl || isLocalTarget(url)) return null;
  return fingerprintTarget(url, opts.fetchFn ?? realFetch);
}

/** Resolves `{confirmed:true}` once it is reasonable to re-test; `{confirmed:false, note}`
 * on timeout — the caller re-tests anyway and shows the note. */
export async function waitForRebuild(
  url: string,
  before: string | null,
  opts: RebuildWaitOptions = {},
): Promise<{ confirmed: boolean; note?: string }> {
  const fetchFn = opts.fetchFn ?? realFetch;
  const sleep = opts.sleepFn ?? realSleep;
  const now = opts.nowFn ?? Date.now;
  const poll = opts.pollMs ?? DEFAULT_POLL_MS;
  const timeout = opts.timeoutMs ?? DEFAULT_REBUILD_TIMEOUT_MS;
  const say = opts.onProgress ?? (() => {});
  const deadline = now() + timeout;

  if (opts.waitForUrl) {
    say(`waiting for ${opts.waitForUrl} to answer…`);
    for (;;) {
      try {
        if ((await fetchFn(opts.waitForUrl)).status === 200) return { confirmed: true };
      } catch {
        /* not up yet */
      }
      if (now() >= deadline) return { confirmed: false, note: UNCONFIRMED_REBUILD_NOTE };
      await sleep(poll);
    }
  }

  if (isLocalTarget(url)) {
    await sleep(opts.graceMs ?? DEFAULT_GRACE_MS); // hot reload
    return { confirmed: true };
  }

  if (before === null) {
    // No "before" to compare against (target was unreachable): nothing to wait for.
    await sleep(opts.graceMs ?? DEFAULT_GRACE_MS);
    return { confirmed: false, note: UNCONFIRMED_REBUILD_NOTE };
  }
  say('waiting for the page to rebuild…');
  for (;;) {
    await sleep(poll);
    const now2 = await fingerprintTarget(url, fetchFn);
    if (now2 !== null && now2 !== before) return { confirmed: true };
    if (now() >= deadline) return { confirmed: false, note: UNCONFIRMED_REBUILD_NOTE };
  }
}
