/* Phase A spike — can Gemini Nano (on-device, $0) act as the NAVIGATOR?
 *
 * The product's cost thesis (see docs/plan/2026-07-01-planner-navigator-split.md):
 * a cheap/free NAVIGATOR picks one action per step from the accessibility tree,
 * while the expensive BRAIN only plans + rescues. Nano is the dream navigator
 * ($0), but the codebase has always assumed "Nano never plans". This spike tests
 * that assumption directly: given a realistic a11y tree + a CURRENT GOAL, can Nano
 * reliably pick the CORRECT next action (right nodeId + right action type), and
 * detect goal-complete / blocked? Text-only — no screenshot needed to pick a
 * nodeId, so this is the exact shape NanoPort.navStep() would use.
 *
 * Mirrors spikes/cdp-logpoint/spike-a-web.js: serves a localhost runner page
 * (Prompt API is web-exposed only on secure contexts), CDP-evaluates the Nano
 * calls in it, prints per-case pick-vs-expected + a GO/NO-GO summary.
 *
 * Run:  cd spikes/nano-nav && npm install && node spike-nano-nav.js
 * Reuses the qa-spike-chrome-profile (already holds the ~2GB model).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const CDP = require('chrome-remote-interface');

const HTTP_PORT = 9335; // distinct from spike-a (9334) so both can coexist
const CDP_PORT = 9224; // same persistent headed profile as spike-a (model already downloaded)
const PROFILE = path.join(process.env.LOCALAPPDATA, 'qa-spike-chrome-profile');

/* ---- exit criteria (tune here) ---- */
const CORRECT_THRESHOLD = 5; // of 6 cases must be correct to call it GO
const MAX_WARM_MS = 9000; // per-pick latency ceiling (warm) to call it GO

/* The in-page Nano navigator — same recipe as runner-assets.ts, but text-only
 * and constrained to a single-action schema instead of the verdict schema. */
const RUNNER_JS = `
window.__status = 'idle';
const MODEL_OPTS = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};
const NAV_SCHEMA = {
  type: 'object',
  required: ['thought', 'action'],
  additionalProperties: false,
  properties: {
    thought: { type: 'string' },
    action: {
      type: 'object',
      required: ['type'],
      additionalProperties: false,
      properties: {
        type: { type: 'string', enum: ['click', 'type', 'navigate', 'goal_complete', 'blocked'] },
        nodeId: { type: 'string' },
        text: { type: 'string' },
        url: { type: 'string' },
        reason: { type: 'string' },
      },
    },
  },
};
let warmSession = null;
window.nav = {
  async avail() {
    if (typeof LanguageModel === 'undefined') return 'api-missing';
    return LanguageModel.availability(MODEL_OPTS);
  },
  async download() {
    window.__status = 'starting download';
    const s = await LanguageModel.create({
      ...MODEL_OPTS,
      monitor(m) { m.addEventListener('downloadprogress', (e) => { window.__status = 'downloading ' + Math.round(e.loaded * 100) + '%'; }); },
    });
    s.destroy();
    window.__status = 'download done';
    return window.nav.avail();
  },
  async warmup() {
    if (!warmSession) {
      warmSession = await LanguageModel.create(MODEL_OPTS);
      await warmSession.prompt([{ role: 'user', content: [{ type: 'text', value: 'ok' }] }]);
    }
    return 'warm';
  },
  async pick(task, goal, axText) {
    const prompt =
      'You are the NAVIGATOR of a browser QA agent. A planner gave you a checklist; ' +
      'you execute ONE goal at a time by choosing ONE action from the page accessibility tree.\\n\\n' +
      'OVERALL TASK: ' + task + '\\n' +
      'CURRENT GOAL: ' + goal + '\\n\\n' +
      'PAGE (accessibility tree; reference the nodeIds like n7 in your action):\\n' + axText + '\\n\\n' +
      'Choose ONE next action toward the CURRENT GOAL:\\n' +
      '- {"type":"click","nodeId":"nX"}\\n' +
      '- {"type":"type","nodeId":"nX","text":"..."}   (typing REPLACES the field)\\n' +
      '- {"type":"navigate","url":"..."}\\n' +
      '- {"type":"goal_complete"}   when the page already satisfies the CURRENT GOAL\\n' +
      '- {"type":"blocked","reason":"..."}   when the page shows an error that stops progress\\n' +
      'Only use nodeIds that appear in the tree above.';
    const t0 = performance.now();
    const session = await LanguageModel.create(MODEL_OPTS);
    const raw = await session.prompt(
      [{ role: 'user', content: [{ type: 'text', value: prompt }] }],
      { responseConstraint: NAV_SCHEMA },
    );
    const ms = Math.round(performance.now() - t0);
    session.destroy();
    let out;
    try { out = JSON.parse(raw); } catch { out = { parseError: true, raw: String(raw).slice(0, 300) }; }
    return { out, ms };
  },
};
`;

/* ---- test cases: representative login -> products -> cart -> checkout ---- *
 * `ok(action)` returns true when the pick is acceptable for that step. */
const TASK = 'Log in with test@demo.com / pw, add an item to the cart, and complete checkout';
const CASES = [
  {
    name: 'login: type email',
    goal: 'Enter test@demo.com into the email field',
    ax: [
      'n1 heading "Sign in"',
      'n4 textbox "Email"',
      'n5 textbox "Password"',
      'n6 button "Sign in"',
    ].join('\n'),
    ok: (a) => a.type === 'type' && a.nodeId === 'n4',
    want: 'type into n4',
  },
  {
    name: 'login: submit',
    goal: 'Submit the sign-in form now that both fields are filled',
    ax: [
      'n1 heading "Sign in"',
      'n4 textbox "Email" value "test@demo.com"',
      'n5 textbox "Password" value "••"',
      'n6 button "Sign in"',
    ].join('\n'),
    ok: (a) => a.type === 'click' && a.nodeId === 'n6',
    want: 'click n6',
  },
  {
    name: 'navigate: open cart',
    goal: 'Open the shopping cart',
    ax: [
      'n2 link "Home"',
      'n3 link "Products"',
      'n9 link "Cart (1)"',
      'n10 button "Account"',
    ].join('\n'),
    ok: (a) => a.type === 'click' && a.nodeId === 'n9',
    want: 'click n9',
  },
  {
    name: 'discriminate: add the RIGHT product (larger tree)',
    goal: "Add the 'Maple Candle' to the cart",
    ax: [
      'n1 navigation',
      '  n2 link "Home"',
      '  n3 link "Products"',
      '  n4 link "Cart (0)"',
      'n5 heading "Our products"',
      'n10 heading "Sandstone Vase"',
      'n11 text "$42.00"',
      'n12 button "Add Sandstone Vase to cart"',
      'n13 heading "Maple Candle"',
      'n14 text "$24.00"',
      'n15 button "Add Maple Candle to cart"',
      'n16 heading "Linen Throw"',
      'n17 text "$68.00"',
      'n18 button "Add Linen Throw to cart"',
    ].join('\n'),
    ok: (a) => a.type === 'click' && a.nodeId === 'n15',
    want: 'click n15',
  },
  {
    name: 'detect goal already complete',
    goal: 'Verify the order confirmation page is shown',
    ax: [
      'n1 heading "Order confirmed"',
      'n2 text "Thank you for your purchase — order #1042"',
      'n3 link "Continue shopping"',
    ].join('\n'),
    ok: (a) => a.type === 'goal_complete',
    want: 'goal_complete',
  },
  {
    name: 'detect blocked (hard error)',
    goal: 'Place the order to complete checkout',
    ax: [
      'n1 heading "Checkout"',
      'n2 alert "Payment failed: your card was declined"',
      'n3 button "Place order"',
    ].join('\n'),
    ok: (a) => a.type === 'blocked',
    want: 'blocked',
  },
];

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
  await sleep(1200);
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
    if (req.url === '/runner.js') { res.setHeader('content-type', 'text/javascript'); return res.end(RUNNER_JS); }
    res.setHeader('content-type', 'text/html');
    res.end('<!DOCTYPE html><html><head><title>nano-nav-runner</title></head><body><h1>Nano navigator spike</h1><script src="/runner.js"></script></body></html>');
  }).listen(HTTP_PORT);

  await ensureChrome();
  const runner = await openTab(`http://localhost:${HTTP_PORT}/runner.html`);

  let a = await evalIn(runner.c, 'nav.avail()');
  console.log('Nano availability:', a);
  if (a === 'downloadable' || a === 'downloading') {
    console.log('triggering on-device model download (one-time, ~2GB)…');
    evalIn(runner.c, 'nav.download()', 60 * 60 * 1000).catch((e) => console.error('download error:', e.message));
    let last = '';
    for (;;) {
      await sleep(4000);
      const s = await evalIn(runner.c, 'window.__status', 10000, false);
      if (s !== last) { console.log('  ', s); last = s; }
      if (s === 'download done') break;
    }
    a = await evalIn(runner.c, 'nav.avail()');
    console.log('availability now:', a);
  }
  if (a !== 'available') {
    console.log('\nNano not available on this machine — cannot run the spike.');
    console.log('(availability "unavailable" is usually the 22GB free-disk gate on the profile volume.)');
    server.close();
    process.exit(2);
  }

  console.log('warming up the model…');
  await evalIn(runner.c, 'nav.warmup()');

  let correct = 0;
  let slow = 0;
  const rows = [];
  for (const tc of CASES) {
    const { out, ms } = await evalIn(
      runner.c,
      `nav.pick(${JSON.stringify(TASK)}, ${JSON.stringify(tc.goal)}, ${JSON.stringify(tc.ax)})`,
    );
    const action = out && out.action ? out.action : { type: '(parse-error)', raw: out && out.raw };
    const good = !out.parseError && tc.ok(action);
    if (good) correct++;
    if (ms > MAX_WARM_MS) slow++;
    rows.push({ name: tc.name, want: tc.want, got: JSON.stringify(action), ms, good });
    console.log(`\n[${good ? 'OK ' : 'MISS'}] ${tc.name}  (${ms} ms)`);
    console.log(`   goal:   ${tc.goal}`);
    console.log(`   want:   ${tc.want}`);
    console.log(`   got:    ${JSON.stringify(action)}`);
    if (out.parseError) console.log(`   raw:    ${out.raw}`);
  }

  const avgMs = Math.round(rows.reduce((s, r) => s + r.ms, 0) / rows.length);
  console.log('\n================ Nano-navigator spike result ================');
  console.log(`correct picks : ${correct}/${CASES.length}  (threshold ${CORRECT_THRESHOLD})`);
  console.log(`avg latency   : ${avgMs} ms  (ceiling ${MAX_WARM_MS} ms; ${slow} case(s) over)`);
  const go = correct >= CORRECT_THRESHOLD && slow === 0;
  console.log(`\nVERDICT: ${go ? 'GO ✅  — Nano is a viable default navigator' : 'NO-GO ❌ — ship Nano-navigator as an experimental toggle; default to a cheap cloud navigator'}`);
  console.log('=============================================================');

  server.close();
  process.exit(go ? 0 : 3);
})().catch((e) => { console.error('SPIKE ERROR:', e.message || e); process.exit(1); });
