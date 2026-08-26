/* Console + network evidence capture over native CDP domains.
 *
 * The spike proved an injected fetch/onerror shim (Page.addScriptToEvaluateOnNewDocument)
 * works on any site with no source access — that trick is kept for the future
 * ExtensionBrowser path. Here we have full CDP, so the native domains are strictly
 * better: Network.* sees every request (fetch, XHR, documents) with real status
 * codes, and Runtime.exceptionThrown reports uncaught page errors with stacks. */

import type CDP from 'chrome-remote-interface';
import type { ConsoleEntry, NetworkEntry } from '../ports/browser-port.js';

export interface CaptureBuffers {
  drainConsole(): ConsoleEntry[];
  drainNetwork(): NetworkEntry[];
  /** A49 (P2): drop in-flight requests the browser never resolved (no
   * `responseReceived`/`loadingFailed` ever arrived — a request whose CDP
   * events got lost, or a long-poll/SSE connection the page itself never
   * closes) once they're older than `maxAgeMs`. Before this, `pending` only
   * ever shrank on a matching settle event, so a long-running session (the
   * daemon, a long suite run) leaked one Map entry per never-settled request
   * forever. Each dropped entry is still recorded as evidence — pushed into
   * the network buffer as a synthetic failed entry (`errorText: 'stale'`) —
   * rather than silently discarded. The CALLER decides when to sweep (see
   * cdp-browser.ts's periodic timer); this module has no timer of its own. */
  sweepStalePending(maxAgeMs: number, now?: number): void;
}

/* A18 (P2): `NetworkEntry.failed` is deliberately narrow — 5xx + transport
 * failure only, because it also drives loop.ts's hard-stop logic
 * (drainHasPageError, the batch-abort check) and widening it to include 4xx
 * would change run outcomes (a 401 auth probe or a missing favicon 404 is
 * routine, not a broken flow). But `failed` being the ONLY signal meant
 * 400/401/403/404 — the most common signature of a real broken API call —
 * never reached the model at all (planner-prompt.ts's networkLines filtered
 * on `.failed` before this fix). `clientError` on NetworkEntry
 * (src/ports/browser-port.ts) is the separate, non-fatal signal for that. */

export async function attachCapture(client: CDP.Client): Promise<CaptureBuffers> {
  let consoleBuf: ConsoleEntry[] = [];
  let networkBuf: NetworkEntry[] = [];
  const pending = new Map<string, { ts: number; method: string; url: string }>();

  await client.Network.enable({});

  client.Runtime.consoleAPICalled(({ type, args }) => {
    consoleBuf.push({
      ts: Date.now(),
      level: type,
      text: args.map((a) => a.value ?? a.description ?? '').join(' '),
    });
  });

  client.Runtime.exceptionThrown(({ exceptionDetails }) => {
    const desc =
      exceptionDetails.exception?.description ??
      exceptionDetails.text ??
      'unknown page error';
    consoleBuf.push({ ts: Date.now(), level: 'page-error', text: `[PAGE-ERROR] ${desc}` });
  });

  client.Network.requestWillBeSent(({ requestId, request }) => {
    pending.set(requestId, { ts: Date.now(), method: request.method, url: request.url });
  });

  client.Network.responseReceived(({ requestId, response }) => {
    const req = pending.get(requestId);
    if (!req) return;
    pending.delete(requestId);
    // A18: `failed` stays 5xx-only (see the top-of-file note); `clientError`
    // separately flags 4xx so it can reach the model as weaker, non-fatal
    // evidence instead of being invisible.
    const entry: NetworkEntry = {
      ts: req.ts,
      method: req.method,
      url: req.url,
      status: response.status,
      ms: Date.now() - req.ts,
      failed: response.status >= 500,
      clientError: response.status >= 400 && response.status < 500,
    };
    networkBuf.push(entry);
  });

  client.Network.loadingFailed(({ requestId, errorText }) => {
    const req = pending.get(requestId);
    if (!req) return;
    pending.delete(requestId);
    networkBuf.push({
      ts: req.ts,
      method: req.method,
      url: req.url,
      ms: Date.now() - req.ts,
      failed: true,
      errorText,
    });
  });

  return {
    drainConsole() {
      const out = consoleBuf;
      consoleBuf = [];
      return out;
    },
    drainNetwork() {
      const out = networkBuf;
      networkBuf = [];
      return out;
    },
    sweepStalePending(maxAgeMs: number, now = Date.now()) {
      for (const [requestId, req] of pending) {
        if (now - req.ts < maxAgeMs) continue;
        pending.delete(requestId);
        networkBuf.push({
          ts: req.ts,
          method: req.method,
          url: req.url,
          ms: now - req.ts,
          failed: true,
          errorText: 'stale',
        });
      }
    },
  };
}

/** First error-shaped evidence in a step's buffers → report.console_error.
 * Priority order matters: page error > console error > 5xx/transport failure
 * > 4xx (A18) — a client error is real signal but weaker than everything
 * above it, so it only surfaces here when nothing more severe was captured. */
export function firstError(console_: ConsoleEntry[], network: NetworkEntry[]): string | undefined {
  const pageError = console_.find((e) => e.level === 'page-error');
  if (pageError) return pageError.text;
  const consoleError = console_.find((e) => e.level === 'error');
  if (consoleError) return consoleError.text;
  const netFail = network.find((e) => e.failed);
  if (netFail) {
    return `[NET-FAIL] ${netFail.method} ${netFail.url} → ${netFail.status ?? netFail.errorText ?? 'failed'}`;
  }
  const netClientError = network.find((e) => e.clientError);
  if (netClientError) {
    return `[NET-4XX] ${netClientError.method} ${netClientError.url} → ${netClientError.status}`;
  }
  return undefined;
}
