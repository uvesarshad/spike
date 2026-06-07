/* V7 — vibe-service + fix-prompt verification. NO Chrome needed.
 *
 * Part 1 (bridge reverse-RPC + VibeService): a plain `ws` client stands in for the
 * extension side panel. It connects to a real BridgeServer (on the isolated port
 * 9413 — 9410-9412 are taken by defaults/other agents), and a VibeService is
 * wired on top. We send reverse requests ({rid, method, params}) and assert the
 * daemon answers with {rid, result} / {rid, error}. We never call vibe.run with a
 * real URL here (that would spawn Chrome) — only vibe.status and the unknown-method
 * path, which exercise the full reverse-RPC plumbing without a browser.
 *
 * Part 2 (pure functions): buildFixPrompt + renderPlainReport on a hand-built
 * failing Report — a click on the "Place order" button, a TypeError console error,
 * and a failed POST 500 — assert the prompt carries repro steps, the verbatim
 * error, the 500, and a deterministic root-cause line. */

import { WebSocket } from 'ws';
import { BridgeServer } from '../src/bridge/bridge-server.js';
import { VibeService } from '../src/vibe/service.js';
import { buildFixPrompt, renderPlainReport } from '../src/vibe/fix-prompt.js';
import type { Report } from '../src/report/report.js';

const BRIDGE_PORT = 9413;

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ---- Part 1: reverse-RPC over a real bridge -------------------------------- */

async function reverseRpcTests(): Promise<void> {
  const bridge = new BridgeServer(BRIDGE_PORT);
  const vibe = new VibeService(bridge);
  vibe.start();

  const ws = new WebSocket(`ws://localhost:${BRIDGE_PORT}/`);
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });

  // collect responses keyed by rid
  const responses = new Map<number, { result?: unknown; error?: string }>();
  ws.on('message', (data) => {
    try {
      const m = JSON.parse(data.toString());
      if (typeof m.rid === 'number') responses.set(m.rid, { result: m.result, error: m.error });
    } catch { /* ignore */ }
  });

  const send = (obj: unknown) => ws.send(JSON.stringify(obj));
  const waitFor = async (rid: number, ms = 2000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (responses.has(rid)) return responses.get(rid)!;
      await sleep(10);
    }
    return undefined;
  };

  // vibe.status → {busy:false}
  send({ rid: 1, method: 'vibe.status' });
  const r1 = await waitFor(1);
  check('vibe.status replies {rid:1, result:{busy:false}}', !!r1 && (r1.result as { busy?: boolean })?.busy === false && r1.error === undefined);

  // unknown method → error response
  send({ rid: 2, method: 'vibe.nonsense' });
  const r2 = await waitFor(2);
  check('unknown method replies {rid:2, error}', !!r2 && typeof r2.error === 'string' && r2.error.includes('unknown method'));

  // a handler throw (vibe.run without params) becomes an error response, not a crash
  send({ rid: 3, method: 'vibe.run', params: {} });
  const r3 = await waitFor(3);
  check('vibe.run with no task/url → error response (no crash)', !!r3 && typeof r3.error === 'string');

  // status still reachable after the above (bridge survived the throw)
  send({ rid: 4, method: 'vibe.status' });
  const r4 = await waitFor(4);
  check('bridge still alive after a handler throw', !!r4 && (r4.result as { busy?: boolean })?.busy === false);

  ws.close();
  await bridge.close();
}

/* ---- Part 2: pure fix-prompt / plain-report -------------------------------- */

function cannedFailingReport(): Report {
  const ts = Date.UTC(2026, 5, 7, 12, 0, 0); // 2026-06-07T12:00:00Z
  return {
    verdict: 'fail',
    failing_step: {
      index: 1,
      action: { type: 'click', nodeId: 'n9' },
      description: 'click n9',
    },
    console_error: "TypeError: Cannot read properties of undefined (reading 'total')",
    evidence_paths: ['artifacts/run-x/report.json', 'artifacts/run-x/screenshots/step-01.png'],
    reason: 'clicking Place order crashed the page',
    runId: 'run-x',
    task: 'Test the checkout flow places an order',
    url: 'http://localhost:9401/checkout',
    steps: [
      {
        index: 0,
        action: { type: 'navigate', url: 'http://localhost:9401/checkout' },
        description: 'navigate',
        ok: true,
        console: [],
        network: [],
        ts,
      },
      {
        index: 1,
        action: { type: 'click', nodeId: 'n9' },
        description: 'click n9',
        target: { role: 'button', name: 'Place order' },
        ok: false,
        error: 'page crashed',
        console: [{ ts, level: 'error', text: "TypeError: Cannot read properties of undefined (reading 'total')" }],
        network: [
          { ts, method: 'POST', url: 'http://localhost:9401/api/order', status: 500, ms: 12, failed: false },
        ],
        screenshot: 'artifacts/run-x/screenshots/step-01.png',
        ts: ts + 1000,
      },
    ],
    model_trace: [],
    durationMs: 4200,
    tokenEstimate: 0,
  };
}

function fixPromptTests(): void {
  const report = cannedFailingReport();
  const prompt = buildFixPrompt(report);

  check('fixPrompt has the one-line ask', prompt.startsWith('Fix this bug found by automated browser testing:'));
  check('fixPrompt has Steps to reproduce + starting URL', prompt.includes('**Steps to reproduce**') && prompt.includes('http://localhost:9401/checkout'));
  check('fixPrompt humanizes the click (Place order button, no nodeId)', prompt.includes('clicked the "Place order" button') && !prompt.includes('n9'));
  check('fixPrompt quotes the console error verbatim', prompt.includes("TypeError: Cannot read properties of undefined (reading 'total')"));
  check('fixPrompt cites the failed POST 500', prompt.includes('500') && prompt.includes('/api/order'));
  check('fixPrompt has a root-cause line (TypeError → undefined property)', /Likely root cause/.test(prompt) && /total/.test(prompt));
  check('fixPrompt has a root-cause line (5xx server-side)', /server-side/.test(prompt));
  check('fixPrompt ends with the whack-a-mole guard', prompt.trim().endsWith('Fix the root cause; do not change unrelated files.'));
  check('fixPrompt includes an ISO evidence timestamp', prompt.includes('2026-06-07T12:00:01'));

  // pass verdict → empty fix prompt
  const passing: Report = { ...cannedFailingReport(), verdict: 'pass', console_error: null, failing_step: null };
  check('buildFixPrompt is empty for a pass verdict', buildFixPrompt(passing) === '');

  const plain = renderPlainReport(report);
  check('plainReport has the friendly fail headline', plain.includes('❌ Found the problem'));
  check('plainReport humanizes the step', plain.includes('clicked the "Place order" button'));
  check('plainReport surfaces the console error in plain words', plain.includes("TypeError: Cannot read properties of undefined (reading 'total')"));
  check('plainReport lists the failed request', plain.includes('/api/order') && plain.includes('500'));

  const plainPass = renderPlainReport(passing);
  check('plainReport pass headline', plainPass.includes('✅ Everything worked'));
}

/* ---- run ------------------------------------------------------------------- */

await reverseRpcTests();
fixPromptTests();

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v7 checks passed`);
process.exit(failed.length ? 1 : 0);
