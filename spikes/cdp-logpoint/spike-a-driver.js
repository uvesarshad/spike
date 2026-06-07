/* Spike A driver — launch headed Chrome with the spike extension loaded,
 * then drive panel.html via CDP: check Gemini Nano availability, trigger the
 * model download if needed, and run a structured verdict on a URL.
 *
 * Usage: node spike-a-driver.js [check|download|verdict <url>]
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const CDP = require('chrome-remote-interface');

const CDP_PORT = 9224;
const ROOT = path.resolve(__dirname, '..');
const EXT_DIR = path.join(ROOT, 'extension');
const PROFILE = path.join(ROOT, '.chrome-profile'); // persistent: model download survives

function findChrome() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  ];
  const found = candidates.find((p) => p && fs.existsSync(p));
  if (!found) throw new Error('chrome.exe not found');
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpAlive() {
  try { await CDP.Version({ port: CDP_PORT }); return true; } catch { return false; }
}

async function ensureChrome() {
  if (await cdpAlive()) return null; // reuse running instance
  const chrome = spawn(findChrome(), [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    `--load-extension=${EXT_DIR}`,
    '--no-first-run', '--window-size=1366,960', 'about:blank',
  ], { stdio: 'ignore', detached: true });
  chrome.unref();
  for (let i = 0; i < 50; i++) { if (await cdpAlive()) return chrome; await sleep(300); }
  throw new Error('CDP port never came up');
}

async function probePanel(extId) {
  // open panel.html for this id and verify it's OUR page (qaSpike present)
  const panelUrl = `chrome-extension://${extId}/panel.html`;
  let t;
  try { t = await CDP.New({ port: CDP_PORT, url: panelUrl }); } catch { return false; }
  await sleep(1200);
  try {
    const client = await CDP({ port: CDP_PORT, target: t.id || t.targetId });
    await client.Runtime.enable();
    const { result } = await client.Runtime.evaluate({ expression: 'typeof qaSpike', returnByValue: true });
    await client.close();
    if (result.value === 'object') return true;
  } catch { /* fallthrough */ }
  try { await CDP.Close({ port: CDP_PORT, id: t.id || t.targetId }); } catch {}
  return false;
}

async function findExtensionId() {
  for (let i = 0; i < 20; i++) {
    const targets = await CDP.List({ port: CDP_PORT });
    const ids = [...new Set(targets
      .filter((t) => t.url.startsWith('chrome-extension://'))
      .map((t) => new URL(t.url).host))];
    // prefer ids whose target url ends with our sw filename
    ids.sort((a, b) => {
      const aw = targets.some((t) => t.url === `chrome-extension://${a}/sw.js`) ? -1 : 0;
      const bw = targets.some((t) => t.url === `chrome-extension://${b}/sw.js`) ? -1 : 0;
      return aw - bw;
    });
    for (const id of ids) if (await probePanel(id)) return id;
    await sleep(500);
  }
  throw new Error('extension not found in targets — was it loaded?');
}

async function getPanel(extId) {
  const panelUrl = `chrome-extension://${extId}/panel.html`;
  let targets = await CDP.List({ port: CDP_PORT });
  let t = targets.find((t) => t.url === panelUrl);
  if (!t) { t = await CDP.New({ port: CDP_PORT, url: panelUrl }); await sleep(1500); }
  const client = await CDP({ port: CDP_PORT, target: t.id || t.targetId });
  await client.Runtime.enable();
  return client;
}

async function evalInPanel(client, expression, timeoutMs = 120000) {
  const { result, exceptionDetails } = await client.Runtime.evaluate({
    expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs,
  });
  if (exceptionDetails) throw new Error('panel threw: ' + JSON.stringify(exceptionDetails, null, 2));
  return result.value;
}

(async () => {
  const mode = process.argv[2] || 'check';
  const url = process.argv[3] || 'https://example.com';

  await ensureChrome();
  const extId = await findExtensionId();
  console.log('extension id:', extId);
  const panel = await getPanel(extId);

  const availability = await evalInPanel(panel, 'qaSpike.checkAvailability()');
  console.log('availability:', availability);

  if (mode === 'download' && (availability === 'downloadable' || availability === 'downloading')) {
    console.log('triggering model download (this may take a while — ~GBs)…');
    evalInPanel(panel, 'qaSpike.downloadModel()', 30 * 60 * 1000).catch((e) => console.error(String(e)));
    // poll status line
    for (;;) {
      await sleep(5000);
      const s = await evalInPanel(panel, `document.getElementById('status').textContent`);
      console.log('  status:', s);
      if (s.includes('available') || s.includes('unavailable')) break;
    }
  }

  if (mode === 'verdict') {
    if (availability !== 'available') { console.log('model not available yet — run download first'); process.exit(2); }
    console.log(`running verdict on ${url} …`);
    const res = await evalInPanel(panel, `qaSpike.runVerdictOnUrl(${JSON.stringify(url)})`, 5 * 60 * 1000);
    console.log(JSON.stringify(res, null, 2));
  }

  await panel.close();
  process.exit(0);
})().catch((e) => { console.error('DRIVER ERROR:', e.message || e); process.exit(1); });
