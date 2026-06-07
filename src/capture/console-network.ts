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
}

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
    networkBuf.push({
      ts: req.ts,
      method: req.method,
      url: req.url,
      status: response.status,
      ms: Date.now() - req.ts,
      failed: response.status >= 500,
    });
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
  };
}

/** First error-shaped evidence in a step's buffers → report.console_error. */
export function firstError(console_: ConsoleEntry[], network: NetworkEntry[]): string | undefined {
  const pageError = console_.find((e) => e.level === 'page-error');
  if (pageError) return pageError.text;
  const consoleError = console_.find((e) => e.level === 'error');
  if (consoleError) return consoleError.text;
  const netFail = network.find((e) => e.failed);
  if (netFail) {
    return `[NET-FAIL] ${netFail.method} ${netFail.url} → ${netFail.status ?? netFail.errorText ?? 'failed'}`;
  }
  return undefined;
}
