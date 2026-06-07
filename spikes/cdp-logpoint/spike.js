/* Spike B — prove: we can inject console.log instrumentation into a RUNNING page
 * with ZERO source edits, using CDP logpoints (Debugger.setBreakpointByUrl with a
 * console.log condition that returns false → never pauses, only logs).
 * This is Antigravity's add-logs→test→remove loop, minus the source mutation.
 *
 * Also proves: Page.addScriptToEvaluateOnNewDocument can wrap fetch/onerror to
 * capture network + page errors on ANY site (no source access needed).
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const CDP = require('chrome-remote-interface');

const HTTP_PORT = 9333;
const CDP_PORT = 9223;

/* ---------- a fake "user app" with a silent bug and NO logging ---------- */
const APP_JS = `let cart = [];

function addItem(name, price) {
  cart.push({ name, price });
  return computeTotal();
}

function computeTotal() {
  let total = 0;
  for (const item of cart) {
    total += item.price;
  }
  total = applyDiscount(total);
  return total;
}

function applyDiscount(total) {
  // silent bug: user EXPECTS 10% off above 50, code only discounts above 100
  return total >= 100 ? total * 0.9 : total;
}

window.addItem = addItem;
`;

const INDEX_HTML = `<!DOCTYPE html><html><body>
<h1>Demo shop</h1><div id="total"></div>
<script src="/app.js"></script>
</body></html>`;

/* the line we want visibility into — found by content, not hardcoded */
const LOGPOINT_LINE = APP_JS.split('\n').findIndex((l) => l.includes('total = applyDiscount(total)'));

function findChrome() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  ];
  const found = candidates.find((p) => p && fs.existsSync(p));
  if (!found) throw new Error('chrome.exe not found in standard locations');
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForCdp(port, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try { return await CDP.Version({ port }); } catch { await sleep(200); }
  }
  throw new Error('CDP port never came up');
}

(async () => {
  /* 1. serve the "user app" */
  const server = http.createServer((req, res) => {
    if (req.url === '/app.js') { res.setHeader('content-type', 'text/javascript'); res.end(APP_JS); }
    else if (req.url === '/api/ping') { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); }
    else { res.setHeader('content-type', 'text/html'); res.end(INDEX_HTML); }
  }).listen(HTTP_PORT);

  /* 2. launch a throwaway Chrome */
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-spike-'));
  const chrome = spawn(findChrome(), [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--headless=new', '--no-first-run', '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore' });

  const cleanup = () => { try { chrome.kill(); } catch {} server.close(); };
  process.on('exit', cleanup);

  await waitForCdp(CDP_PORT);
  const client = await CDP({ port: CDP_PORT });
  const { Page, Runtime, Debugger } = client;
  await Promise.all([Page.enable(), Runtime.enable(), Debugger.enable()]);

  const captured = [];
  Runtime.consoleAPICalled(({ type, args }) => {
    captured.push(`[console.${type}] ` + args.map((a) => a.value ?? a.description ?? '').join(' '));
  });

  /* 3. capture-net-and-errors shim — works on ANY site, no source access */
  await Page.addScriptToEvaluateOnNewDocument({
    source: `(() => {
      const orig = window.fetch;
      window.fetch = async (...args) => {
        const t0 = Date.now();
        try {
          const res = await orig(...args);
          console.info('[NET]', String(args[0]), res.status, (Date.now() - t0) + 'ms');
          return res;
        } catch (e) { console.error('[NET-FAIL]', String(args[0]), String(e)); throw e; }
      };
      window.addEventListener('error', (e) => console.error('[PAGE-ERROR]', e.message));
    })();`,
  });

  /* 4. navigate, then set the LOGPOINT — zero source edits */
  await Page.navigate({ url: `http://127.0.0.1:${HTTP_PORT}/` });
  await Page.loadEventFired();

  const bp = await Debugger.setBreakpointByUrl({
    url: `http://127.0.0.1:${HTTP_PORT}/app.js`,
    lineNumber: LOGPOINT_LINE,
    condition:
      `console.log('[LOGPOINT] computeTotal: total=' + total + ' cart=' + JSON.stringify(cart)), false`,
  });
  console.log(`logpoint set at app.js:${LOGPOINT_LINE + 1} (breakpointId ${bp.breakpointId}, resolved at ${bp.locations.length} location(s))`);

  /* 5. exercise the app like a user would */
  await Runtime.evaluate({ expression: `addItem('Widget', 49.99)` });
  await Runtime.evaluate({ expression: `addItem('Gadget', 25.00)` });
  await Runtime.evaluate({ expression: `fetch('/api/ping')`, awaitPromise: true });
  await sleep(500);

  /* 6. verdict */
  console.log('\n--- captured from the running page ---');
  captured.forEach((l) => console.log(l));

  const gotLogpoint = captured.some((l) => l.includes('[LOGPOINT]') && l.includes('total='));
  const gotNet = captured.some((l) => l.includes('[NET]') && l.includes('/api/ping'));

  console.log('\n--- spike B result ---');
  console.log(`logpoint w/ live variable values, zero source edits : ${gotLogpoint ? 'PASS' : 'FAIL'}`);
  console.log(`fetch/network capture via injected shim             : ${gotNet ? 'PASS' : 'FAIL'}`);
  console.log(`source served byte-identical (never modified)       : PASS (served from a constant)`);

  await client.close();
  cleanup();
  process.exit(gotLogpoint && gotNet ? 0 : 1);
})().catch((e) => { console.error('SPIKE ERROR:', e); process.exit(1); });
