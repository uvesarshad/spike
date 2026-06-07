/* Spike A — prove: a Chrome extension can get a STRUCTURED QA verdict on a page
 * screenshot from Gemini Nano, fully on-device, no API key, $0 per call.
 * Exposes window.qaSpike for CDP-driven automation. */

const $ = (id) => document.getElementById(id);
const out = (v) => { $('out').textContent = typeof v === 'string' ? v : JSON.stringify(v, null, 2); };
const status = (s) => { $('status').textContent = s; };

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

async function checkAvailability() {
  if (typeof LanguageModel === 'undefined') {
    status('LanguageModel API NOT present (need Chrome 138+ desktop)');
    return 'api-missing';
  }
  const a = await LanguageModel.availability(MODEL_OPTS);
  status(`availability: ${a}`);
  $('btnDownload').disabled = !(a === 'downloadable' || a === 'downloading');
  $('btnRun').disabled = a !== 'available';
  return a;
}

async function downloadModel() {
  status('creating session (triggers model download)…');
  $('progress').hidden = false;
  const session = await LanguageModel.create({
    ...MODEL_OPTS,
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => {
        $('progress').value = e.loaded;
        status(`downloading model… ${Math.round(e.loaded * 100)}%`);
      });
    },
  });
  session.destroy();
  $('progress').hidden = true;
  return checkAvailability();
}

async function captureUrl(url) {
  // Open target URL in a tab, let it render, capture, close.
  const tab = await chrome.tabs.create({ url, active: true });
  await new Promise((r) => setTimeout(r, 5000));
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  await chrome.tabs.remove(tab.id);
  return dataUrl;
}

async function runVerdictOnUrl(url, task) {
  url = url || $('url').value;
  task = task || $('task').value;
  out('capturing ' + url + ' …');
  const dataUrl = await captureUrl(url);
  $('shot').src = dataUrl;
  $('shot').hidden = false;

  out('asking Gemini Nano…');
  const blob = await (await fetch(dataUrl)).blob();
  const t0 = performance.now();
  const session = await LanguageModel.create(MODEL_OPTS);
  const raw = await session.prompt(
    [{
      role: 'user',
      content: [
        { type: 'text', value:
          `You are a QA assistant inspecting a screenshot of a web page.\n` +
          `Question: ${task}\n` +
          `Judge strictly from what is visible. List concrete issues if any.` },
        { type: 'image', value: blob },
      ],
    }],
    { responseConstraint: VERDICT_SCHEMA },
  );
  const ms = Math.round(performance.now() - t0);
  session.destroy();

  let verdict;
  try { verdict = JSON.parse(raw); } catch { verdict = { parseError: true, raw }; }
  $('timing').textContent = `${ms} ms · on-device · $0.00`;
  out(verdict);
  const cls = verdict.verdict || 'uncertain';
  $('out').className = cls;
  return { verdict, ms };
}

$('btnAvail').addEventListener('click', () => checkAvailability().catch((e) => out(String(e))));
$('btnDownload').addEventListener('click', () => downloadModel().catch((e) => out(String(e))));
$('btnRun').addEventListener('click', () => runVerdictOnUrl().catch((e) => out(String(e))));

// for CDP-driven automation
window.qaSpike = { checkAvailability, downloadModel, runVerdictOnUrl };
checkAvailability().catch((e) => out(String(e)));
