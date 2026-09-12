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
import type { InteractiveElement } from './html.js';

/** One node of the accessibility tree, taken structurally for the same reason
 * the browser below is — the discovery layer never imports a port. Matches the
 * shape `BrowserPort.axTree()` already returns. */
export interface AxNodeLike {
  role: string;
  name?: string;
  children?: AxNodeLike[];
}

/** What a crawl needs from whatever is driving Chrome. Every BrowserPort
 * implementation that exposes `cdpClient()` satisfies it as-is. */
export interface CrawlBrowser {
  navigate(url: string): Promise<void>;
  url(): Promise<string>;
  drainConsole(): Array<{ level: string; text: string }>;
  drainNetwork(): Array<{ url: string; status?: number; failed?: boolean; errorText?: string }>;
  waitForIdle?(opts?: { quietMs?: number; timeoutMs?: number }): Promise<void>;
  cdpClient?(): unknown;
  /** A33: the page's accessibility tree, when the driver can supply one. */
  axTree?(): Promise<{ root: AxNodeLike }>;
}

/* A33 — naming the controls the way the run will name them.
 *
 * The map and a live run were reading the same page through two different
 * lenses: the map extracted control names out of the markup (an `id`, a
 * `name`, a placeholder), while a run names whatever it clicks the way the
 * browser's accessibility tree does (from a `<label>`, an `aria-label`, the
 * visible text). So the map would record `user_email` where the run reported
 * "Email address", the two never matched, and every one of those controls
 * looked untested forever — coverage under-reported by an unknown amount and
 * there was no way to tell which part was real.
 *
 * Reading the names off the SAME accessibility tree the run uses removes the
 * mismatch at the source. The markup-based extraction stays as the fallback
 * for a plain HTTP map, which has no browser and therefore no tree. */

/** Roles worth counting as a control someone can operate. Deliberately the
 * same set the markup extractor uses (html.ts's INTERACTIVE_ROLES) plus the
 * accessibility-tree spellings of the same things, so a browser-driven map and
 * an HTTP one count comparable denominators. */
const AX_INTERACTIVE_ROLES = new Set([
  'link', 'button', 'checkbox', 'radio', 'combobox', 'textbox', 'searchbox', 'switch', 'menuitem', 'tab',
]);

/** Every operable control in an accessibility tree, deduplicated by role+name,
 * in document order. Exported for testing without a browser. */
export function interactiveElementsFromAx(root: AxNodeLike | undefined): InteractiveElement[] {
  const out: InteractiveElement[] = [];
  const seen = new Set<string>();
  const walk = (node: AxNodeLike | undefined, depth: number): void => {
    if (!node || depth > 200) return;
    if (AX_INTERACTIVE_ROLES.has(node.role)) {
      const name = (node.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
      const key = `${node.role}|${name.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ role: node.role, ...(name && { name }) });
      }
    }
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  walk(root, 0);
  return out;
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

    // A33: name the page's controls off the accessibility tree — the same
    // source a run names what it clicks from — so the two sides can actually
    // be matched up. A driver that cannot supply one leaves this absent and
    // the crawler falls back to reading the markup.
    let interactiveElements: InteractiveElement[] | undefined;
    if (browser.axTree) {
      try {
        const snapshot = await browser.axTree();
        interactiveElements = interactiveElementsFromAx(snapshot?.root);
      } catch {
        /* no tree for this page — the markup fallback still applies */
      }
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

    return { url: finalUrl, status, html, pageErrors, failedRequests, ...(interactiveElements && { interactiveElements }) };
  };
}
