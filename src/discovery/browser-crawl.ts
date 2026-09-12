/* A24 — crawling through a real browser instead of raw HTTP requests.
 *
 * `crawlSite` takes an injected fetch-or-navigate function so it can stay
 * browser-agnostic and testable with no network at all. Until now the only
 * production implementation was a bare `fetch()`, which is blind in exactly
 * the two ways that matter most:
 *
 *   - it carries no session, so every page behind a sign-in came back as the
 *     login screen (or a 302 to it) and the map stopped at the front door;
 *   - it reads the served markup, so an app that draws itself in the browser
 *     yielded one route and no controls at all.
 *
 * This module is the other implementation: navigate the page the user is
 * already signed in on, let it finish rendering, and take the DOM as it
 * actually is. It also gets the two things raw HTTP can never see for free —
 * uncaught JavaScript errors, and the calls the page makes after it loads —
 * which is what `findingsForPage` judges.
 *
 * The port is taken STRUCTURALLY (the small shape below), not as a
 * `BrowserPort` import: the discovery layer's own rule is that it never
 * depends on the engine or a port implementation, and everything here needs
 * is navigate + evaluate + the two drains. A fake satisfying this shape is
 * enough to test it. */

import type { FailedRequest, Fetched, Fetcher } from './crawler.js';

/** What a crawl needs from whatever is driving Chrome. Every BrowserPort
 * implementation that exposes `cdpClient()` satisfies it as-is. */
export interface CrawlBrowser {
  navigate(url: string): Promise<void>;
  url(): Promise<string>;
  drainConsole(): Array<{ level: string; text: string }>;
  drainNetwork(): Array<{ url: string; status?: number; failed?: boolean; errorText?: string }>;
  waitForIdle?(opts?: { quietMs?: number; timeoutMs?: number }): Promise<void>;
  cdpClient?(): unknown;
}

/** Minimal slice of the CDP client this module drives. */
interface EvaluatingClient {
  Runtime: { evaluate(params: { expression: string; returnByValue?: boolean; awaitPromise?: boolean }): Promise<{ result: { value?: unknown } }> };
}

export interface BrowserCrawlOptions {
  /** How long to let a page settle before reading its DOM. Client-rendered
   * pages paint after their first data call, so reading immediately after
   * navigate would capture an empty shell. */
  quietMs?: number;
  timeoutMs?: number;
  /** Origin whose failed requests count as this page's fault. A third-party
   * analytics call failing is not the site's bug and must not fail a map;
   * defaults to each visited URL's own origin. */
  sameOrigin?: string;
}

/** Strip the noisy prefix the console capture adds, so a finding reads as the
 * error the page threw rather than as our own log format. */
function cleanPageError(text: string): string {
  return text.replace(/^\[PAGE-ERROR\]\s*/, '').trim();
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** Build a `Fetcher` that drives a live browser. Returns `null` for a page it
 * could not reach at all — the crawler treats that as a dead end, exactly as
 * it does for a failed HTTP request. */
export function browserFetcher(browser: CrawlBrowser, opts: BrowserCrawlOptions = {}): Fetcher {
  return async (url: string): Promise<Fetched | null> => {
    // Drop anything buffered from the previous page: whatever is in the
    // buffers when we navigate belongs to the page we are leaving, and
    // attributing it to this one would report a finding on the wrong route.
    browser.drainConsole();
    browser.drainNetwork();

    try {
      await browser.navigate(url);
    } catch {
      return null;
    }

    try {
      await browser.waitForIdle?.({ quietMs: opts.quietMs ?? 500, timeoutMs: opts.timeoutMs ?? 10_000 });
    } catch {
      // A page that never goes quiet (a poller, a long-lived socket) is still
      // worth reading — we just read it as it stands.
    }

    const client = browser.cdpClient?.() as EvaluatingClient | undefined;
    if (!client) return null;

    let html = '';
    try {
      const { result } = await client.Runtime.evaluate({ expression: 'document.documentElement ? document.documentElement.outerHTML : ""', returnByValue: true });
      html = typeof result.value === 'string' ? result.value : '';
    } catch {
      return null;
    }

    // The address AFTER navigation, so a redirect (a sign-in bounce, an
    // apex→www hop) is recorded as where we actually ended up.
    let finalUrl = url;
    try {
      finalUrl = (await browser.url()) || url;
    } catch {
      /* keep the requested url */
    }

    const console_ = browser.drainConsole();
    const network = browser.drainNetwork();
    const sameOrigin = opts.sameOrigin ?? originOf(finalUrl);

    // The document's own status: the network entry for the page we landed on.
    // A page served from the back/forward cache or a client-side route change
    // produces no document entry at all, and 200 is then the right reading —
    // the browser showed the page.
    const docEntry = network.find((e) => e.url === finalUrl || e.url === url);
    const status = docEntry?.status ?? 200;

    const pageErrors = console_.filter((e) => e.level === 'page-error').map((e) => cleanPageError(e.text)).filter(Boolean);

    const failedRequests: FailedRequest[] = [];
    for (const e of network) {
      if (!e.failed) continue;
      if (e === docEntry) continue; // reported as the page's own status instead
      if (sameOrigin && originOf(e.url) !== sameOrigin) continue; // someone else's outage
      failedRequests.push({ url: e.url, ...(e.status !== undefined && { status: e.status }), ...(e.errorText && { errorText: e.errorText }) });
    }

    return { url: finalUrl, status, html, pageErrors, failedRequests };
  };
}
