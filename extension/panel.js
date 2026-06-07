/* Vibe-mode side panel.
 *
 * The non-technical face of the QA subagent: type a plain-English task, watch
 * the run, get a verdict + a paste-ready fix prompt.
 *
 * Talks ONLY to the service worker over a long-lived chrome.runtime port named
 * 'vibe-panel'. The SW relays our run/status/nano/bridge-status requests to the
 * daemon and broadcasts the daemon's vibe.* events back to us.
 *
 *   panel -> SW : { kind:'run', task, url }
 *                 { kind:'status' }
 *                 { kind:'nano' }
 *                 { kind:'bridge-status' }
 *   SW -> panel : { kind:'accepted', accepted? }
 *                 { kind:'error', message }       (run rejected / daemon down)
 *                 { kind:'status', busy }
 *                 { kind:'nano', availability }
 *                 { kind:'bridge-status', connected }
 *                 { kind:'progress', line }       (relayed vibe.progress)
 *                 { kind:'done', ...verdict }     (relayed vibe.done)
 *                 { kind:'error', message }       (relayed vibe.error)
 */

const URL_KEY = 'vibe.url';
const DEFAULT_URL = 'http://localhost:9401/login';

// ---- elements --------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const bridgeDot = $('bridgeDot');
const nanoLine = $('nanoLine');
const urlInput = $('url');
const taskInput = $('task');
const runBtn = $('runBtn');
const errorBanner = $('errorBanner');
const feed = $('feed');
const resultCard = $('resultCard');
const verdictBadge = $('verdictBadge');
const plainReport = $('plainReport');
const fixSection = $('fixSection');
const fixPrompt = $('fixPrompt');
const copyBtn = $('copyBtn');

let busy = false;

// ---- port ------------------------------------------------------------------
let port = connectPort();

function connectPort() {
  const p = chrome.runtime.connect({ name: 'vibe-panel' });
  p.onMessage.addListener(onPortMessage);
  p.onDisconnect.addListener(() => {
    // SW went idle/torn down; reconnect lazily on next tick.
    void chrome.runtime.lastError;
    port = null;
    setTimeout(() => { port = connectPort(); requestInitialState(); }, 500);
  });
  return p;
}

function postToSW(message) {
  try {
    if (!port) port = connectPort();
    port.postMessage(message);
  } catch {
    port = connectPort();
    try { port.postMessage(message); } catch { /* give up this tick */ }
  }
}

// ---- incoming SW messages --------------------------------------------------
function onPortMessage(msg) {
  if (!msg || typeof msg.kind !== 'string') return;
  switch (msg.kind) {
    case 'bridge-status':
      setBridge(!!msg.connected);
      break;
    case 'nano':
      setNano(msg.availability);
      break;
    case 'status':
      setBusy(!!msg.busy);
      if (msg.busy) addFeedLine('(a test is already running — showing live progress)');
      break;
    case 'accepted':
      setBusy(true);
      hideError();
      addFeedLine('Run accepted. Starting…');
      break;
    case 'progress':
      addFeedLine(msg.line);
      break;
    case 'done':
      setBusy(false);
      renderResult(msg);
      break;
    case 'error':
      setBusy(false);
      showError(msg.message || 'Something went wrong.');
      break;
    default:
      break;
  }
}

// ---- header state ----------------------------------------------------------
function setBridge(connected) {
  bridgeDot.classList.toggle('dot-on', connected);
  bridgeDot.classList.toggle('dot-off', !connected);
  bridgeDot.title = connected ? 'Daemon connected' : 'Daemon not connected';
}

function setNano(availability) {
  let text;
  switch (availability) {
    case 'available':
    case 'readily':
      text = 'On-device AI: ready';
      break;
    case 'downloadable':
    case 'downloading':
    case 'after-download':
      text = 'On-device AI: downloading — testing still works via cloud free tier';
      break;
    default:
      text = 'On-device AI: unavailable — testing still works via cloud free tier';
      break;
  }
  nanoLine.textContent = text;
}

// ---- busy / run button -----------------------------------------------------
function setBusy(value) {
  busy = value;
  runBtn.disabled = value;
  runBtn.textContent = value ? 'Testing…' : 'Run test';
}

// ---- feed ------------------------------------------------------------------
function addFeedLine(line) {
  if (line === undefined || line === null) return;
  const el = document.createElement('span');
  el.className = 'feed-line';
  const ts = document.createElement('span');
  ts.className = 'feed-ts';
  ts.textContent = new Date().toLocaleTimeString();
  el.appendChild(ts);
  el.appendChild(document.createTextNode(String(line)));
  feed.appendChild(el);
  feed.scrollTop = feed.scrollHeight;
}

function clearFeed() {
  feed.textContent = '';
}

// ---- error banner ----------------------------------------------------------
function showError(message) {
  errorBanner.textContent = message;
  errorBanner.hidden = false;
}
function hideError() {
  errorBanner.hidden = true;
}

// ---- result card -----------------------------------------------------------
function renderResult(params) {
  const verdict = String(params.verdict || 'uncertain').toLowerCase();
  verdictBadge.className = 'verdict-badge';
  if (verdict === 'pass') {
    verdictBadge.classList.add('verdict-pass');
    verdictBadge.textContent = '✅ PASS';
  } else if (verdict === 'fail') {
    verdictBadge.classList.add('verdict-fail');
    verdictBadge.textContent = '❌ FAIL';
  } else {
    verdictBadge.classList.add('verdict-uncertain');
    verdictBadge.textContent = '🤔 UNCERTAIN';
  }

  plainReport.textContent = params.plainReport || params.reason || '(no report)';

  const fix = (params.fixPrompt || '').trim();
  if (fix) {
    fixPrompt.value = fix;
    fixSection.hidden = false;
    resetCopyBtn();
  } else {
    fixSection.hidden = true;
  }

  resultCard.hidden = false;
  resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  if (params.durationMs) {
    addFeedLine(`Done in ${(params.durationMs / 1000).toFixed(1)}s.`);
  } else {
    addFeedLine('Done.');
  }
}

// ---- copy fix prompt -------------------------------------------------------
let copyTimer = null;
function resetCopyBtn() {
  copyBtn.classList.remove('copied');
  copyBtn.textContent = 'Copy';
}
function flashCopied() {
  copyBtn.classList.add('copied');
  copyBtn.textContent = 'Copied ✓';
  if (copyTimer) clearTimeout(copyTimer);
  copyTimer = setTimeout(resetCopyBtn, 2000);
}

copyBtn.addEventListener('click', async () => {
  const text = fixPrompt.value;
  try {
    await navigator.clipboard.writeText(text);
    flashCopied();
  } catch {
    // fallback: select + execCommand
    fixPrompt.focus();
    fixPrompt.select();
    try {
      document.execCommand('copy');
      flashCopied();
    } catch {
      /* nothing more we can do */
    }
    window.getSelection().removeAllRanges();
  }
});

// ---- run -------------------------------------------------------------------
runBtn.addEventListener('click', () => {
  if (busy) return;
  const url = urlInput.value.trim() || DEFAULT_URL;
  const task = taskInput.value.trim();
  if (!task) {
    showError('Tell me what to test first (e.g. "log in and reach the dashboard").');
    taskInput.focus();
    return;
  }
  hideError();
  resultCard.hidden = true;
  clearFeed();
  addFeedLine(`Asking the agent to test: ${url}`);
  persistUrl(url);
  // optimistic; the SW confirms with 'accepted' or 'error'
  setBusy(true);
  postToSW({ kind: 'run', task, url });
});

// ---- url persistence -------------------------------------------------------
function persistUrl(url) {
  try { chrome.storage.local.set({ [URL_KEY]: url }); } catch { /* noop */ }
}

function loadUrl() {
  try {
    chrome.storage.local.get(URL_KEY, (data) => {
      void chrome.runtime.lastError;
      const stored = data && data[URL_KEY];
      urlInput.value = stored || DEFAULT_URL;
    });
  } catch {
    urlInput.value = DEFAULT_URL;
  }
}

// ---- initial state + polling ----------------------------------------------
function requestInitialState() {
  postToSW({ kind: 'bridge-status' });
  postToSW({ kind: 'nano' });
  postToSW({ kind: 'status' });
}

loadUrl();
requestInitialState();

// poll the bridge connection so the dot stays accurate
setInterval(() => postToSW({ kind: 'bridge-status' }), 3000);
