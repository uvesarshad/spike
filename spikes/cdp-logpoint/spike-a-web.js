/* Spike A (web variant) — prove Gemini Nano (on-device, $0, no API key) returns a
 * STRUCTURED QA verdict on page screenshots, and can DISCRIMINATE good vs broken UI.
 *
 * Serves three local pages:
 *   /runner.html  — the Nano harness (localhost = secure context → LanguageModel exposed)
 *   /good.html    — healthy mini-dashboard          → expect verdict: pass
 *   /bad.html     — blank page with a crash banner  → expect verdict: fail
 *
 * Driver: CDP-navigates tabs, captures screenshots via Page.captureScreenshot,
 * feeds them to the runner page, prints verdicts.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const CDP = require('chrome-remote-interface');

const HTTP_PORT = 9334;
const CDP_PORT = 9224;
const ROOT = path.resolve(__dirname, '..');
// profile must live on a volume with 22GB+ free — Nano's storage requirement
const PROFILE = path.join(process.env.LOCALAPPDATA, 'qa-spike-chrome-profile');

const RUNNER_JS = `
window.__status = 'idle';
const MODEL_OPTS = {
  expectedInputs: [{ type: 'text', languages: ['en'] }, { type: 'image' }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};
const VERDICT_SCHEMA = {
  type: 'object',
  required: ['verdict', 'summary', 'issues'],
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail', 'uncertain'] },
    summary: { type: 'string' },
    issues: { type: 'array', items: { type: 'string' } },
  },
};
window.spike = {
  async avail() {
    if (typeof LanguageModel === 'undefined') return 'api-missing';
    return LanguageModel.availability(MODEL_OPTS);
  },
  async download() {
    window.__status = 'starting download';
    const session = await LanguageModel.create({
      ...MODEL_OPTS,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          window.__status = 'downloading ' + Math.round(e.loaded * 100) + '%';
        });
      },
    });
    session.destroy();
    window.__status = 'download done';
    return window.spike.avail();
  },
  async verdict(dataUrl, task) {
    const blob = await (await fetch(dataUrl)).blob();
    const t0 = performance.now();
    const session = await LanguageModel.create(MODEL_OPTS);
    const raw = await session.prompt(
      [{
        role: 'user',
        content: [
          { type: 'text', value:
            'You are a QA assistant inspecting a screenshot of a web page.\\n' +
            'Question: ' + task + '\\n' +
            'Judge strictly from what is visible. List concrete issues if any.' },
          { type: 'image', value: blob },
        ],
      }],
      { responseConstraint: VERDICT_SCHEMA },
    );
    const ms = Math.round(performance.now() - t0);
    session.destroy();
    let v; try { v = JSON.parse(raw); } catch { v = { parseError: true, raw }; }
    return { verdict: v, ms };
  },
};
`;

const PAGES = {
  '/runner.html': `<!DOCTYPE html><html><head><title>nano-runner</title></head>
<body><h1>Nano runner</h1><script src="/runner.js"></script></body></html>`,
  '/runner.js': RUNNER_JS,
  '/good.html': `<!DOCTYPE html><html><head><title>Acme Dashboard</title><style>
  body{font-family:system-ui;margin:0;background:#f6f7fb;color:#16161c}
  nav{background:#16161c;color:#fff;padding:14px 28px;display:flex;gap:24px;font-size:14px}
  nav b{color:#9aa0ff}.wrap{max-width:960px;margin:28px auto;padding:0 20px}
  .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
  .card{background:#fff;border:1px solid #e6e7ef;border-radius:14px;padding:18px}
  .kpi{font-size:26px;font-weight:700}.lbl{font-size:12px;color:#777}
  table{width:100%;margin-top:24px;background:#fff;border-radius:14px;border-collapse:collapse;overflow:hidden}
  td,th{padding:10px 14px;border-bottom:1px solid #eee;font-size:13px;text-align:left}
  </style></head><body>
  <nav><b>Acme</b><span>Dashboard</span><span>Orders</span><span>Customers</span><span>Settings</span></nav>
  <div class="wrap"><h2>Overview</h2>
  <div class="cards">
    <div class="card"><div class="lbl">Revenue</div><div class="kpi">$48,210</div></div>
    <div class="card"><div class="lbl">Orders</div><div class="kpi">1,284</div></div>
    <div class="card"><div class="lbl">Customers</div><div class="kpi">312</div></div>
  </div>
  <table><tr><th>Order</th><th>Customer</th><th>Total</th><th>Status</th></tr>
  <tr><td>#1042</td><td>Dana Cruz</td><td>$129.00</td><td>Shipped</td></tr>
  <tr><td>#1041</td><td>Lee Park</td><td>$89.50</td><td>Paid</td></tr>
  <tr><td>#1040</td><td>Sam Reed</td><td>$240.00</td><td>Pending</td></tr></table>
  </div></body></html>`,
  '/bad.html': `<!DOCTYPE html><html><head><title>Acme Dashboard</title></head>
  <body style="font-family:system-ui;background:#fff">
  <div style="background:#ffe2e2;color:#a40000;padding:14px 20px;font-size:14px">
  Application error: a client-side exception has occurred (see the browser console for more information).</div>
  <div style="height:480px"></div></body></html>`,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  ];
  const f = candidates.find((p) => p && fs.existsSync(p));
  if (!f) throw new Error('chrome.exe not found');
  return f;
}

async function cdpAlive() { try { await CDP.Version({ port: CDP_PORT }); return true; } catch { return false; } }

async function ensureChrome() {
  if (await cdpAlive()) return;
  const chrome = spawn(findChrome(), [
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--window-size=1366,960', 'about:blank',
  ], { stdio: 'ignore', detached: true });
  chrome.unref();
  for (let i = 0; i < 50; i++) { if (await cdpAlive()) return; await sleep(300); }
  throw new Error('CDP never came up');
}

async function openTab(url) {
  const t = await CDP.New({ port: CDP_PORT, url });
  await sleep(1500);
  const c = await CDP({ port: CDP_PORT, target: t.id });
  await c.Runtime.enable(); await c.Page.enable();
  return { id: t.id, c };
}

async function evalIn(c, expression, timeout = 600000, userGesture = true) {
  const { result, exceptionDetails } = await c.Runtime.evaluate({
    expression, awaitPromise: true, returnByValue: true, timeout, userGesture,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || JSON.stringify(exceptionDetails));
  return result.value;
}

(async () => {
  const server = http.createServer((req, res) => {
    const body = PAGES[req.url] ?? PAGES['/runner.html'];
    res.setHeader('content-type', req.url.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(body);
  }).listen(HTTP_PORT);

  await ensureChrome();
  const runner = await openTab(`http://localhost:${HTTP_PORT}/runner.html`);

  /* 1. availability */
  let a = await evalIn(runner.c, 'spike.avail()');
  console.log('availability:', a);

  /* 2. download if needed */
  if (a === 'downloadable' || a === 'downloading') {
    console.log('triggering on-device model download…');
    evalIn(runner.c, 'spike.download()', 60 * 60 * 1000).catch((e) => console.error('download error:', e.message));
    let last = '';
    for (;;) {
      await sleep(4000);
      const s = await evalIn(runner.c, 'window.__status', 10000, false);
      if (s !== last) { console.log('  ', s); last = s; }
      if (s === 'download done') break;
    }
    a = await evalIn(runner.c, 'spike.avail()');
    console.log('availability now:', a);
  }
  if (a !== 'available') { console.log('model not available — cannot run verdicts'); process.exit(2); }

  /* 3. verdicts on good + bad pages */
  const TASK = 'Does this page render correctly: a complete dashboard UI with visible navigation and content, no blank areas, no error messages, no obviously broken layout?';
  const results = {};
  for (const page of ['good', 'bad']) {
    const tab = await openTab(`http://localhost:${HTTP_PORT}/${page}.html`);
    await tab.c.Page.bringToFront();
    await sleep(800);
    const shot = await tab.c.Page.captureScreenshot({ format: 'png' });
    await CDP.Close({ port: CDP_PORT, id: tab.id });
    await tab.c.close();

    await runner.c.Page.bringToFront();
    const dataUrl = 'data:image/png;base64,' + shot.data;
    const res = await evalIn(runner.c, `spike.verdict(${JSON.stringify(dataUrl)}, ${JSON.stringify(TASK)})`);
    results[page] = res;
    console.log(`\n--- ${page}.html → Nano verdict (${res.ms} ms, on-device, $0.00) ---`);
    console.log(JSON.stringify(res.verdict, null, 2));
  }

  /* 4. spike verdict */
  const ok = results.good?.verdict?.verdict === 'pass' && results.bad?.verdict?.verdict === 'fail';
  console.log('\n--- spike A result ---');
  console.log(`structured output (JSON schema enforced)   : ${results.good?.verdict?.verdict ? 'PASS' : 'FAIL'}`);
  console.log(`discriminates good vs broken UI            : ${ok ? 'PASS' : 'CHECK MANUALLY (see verdicts above)'}`);

  server.close();
  process.exit(0);
})().catch((e) => { console.error('SPIKE ERROR:', e.message || e); process.exit(1); });
