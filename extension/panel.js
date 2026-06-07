/* Vibe-mode side panel.
 *
 * The non-technical face of the QA subagent: pick a task (or tap a suggestion),
 * watch the run drive THIS tab, get a verdict + a paste-ready fix prompt.
 *
 * Talks ONLY to the service worker over a long-lived chrome.runtime port named
 * 'vibe-panel'. The SW relays our run/status/nano/bridge-status requests to the
 * daemon and broadcasts the daemon's vibe.* events back to us.
 *
 *   panel -> SW : { kind:'run', task, tabId, url }
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
 *                 { kind:<plan|click|type|navigate|assert|wait|finish>,
 *                   index, text, ok? }            (relayed vibe.step — see below)
 *
 * STEP-EVENT KIND COLLISION
 * The daemon emits vibe.step events with params { index, kind, text, ok }. The
 * SW rebroadcasts them as { kind:'step', ...(params) } — and because the spread
 * comes AFTER the literal `kind:'step'`, the params' own `kind` WINS. So a step
 * actually arrives at the panel as { kind:'click', index, text, ok } etc., NOT
 * { kind:'step' }. We therefore treat any message whose kind is one of the
 * known step kinds as a step event (and also accept a literal kind:'step' that
 * still carries an inner kind, for robustness against either spread order).
 */

// ---- step kinds ------------------------------------------------------------
const STEP_KINDS = ['plan', 'click', 'type', 'navigate', 'assert', 'wait', 'finish'];
const STEP_ICON = {
  plan: '🧠',
  click: '🖱️',
  type: '⌨️',
  navigate: '🧭',
  assert: '👁️',
  wait: '⏳',
  finish: '🏁',
};

// ---- elements --------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const bridgeDot = $('bridgeDot');
const nanoLine = $('nanoLine');
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
const suggestions = $('suggestions');
const tabFavicon = $('tabFavicon');
const tabTitle = $('tabTitle');
const tabHost = $('tabHost');
const tabWarning = $('tabWarning');

let busy = false;

// the active tab we will test (refreshed on activation/update)
let activeTab = null; // { id, url, title, favIconUrl }

// the timeline row that is still "in flight" (latest step while busy)
let pendingStepRow = null;

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

  // Step events arrive with the step's OWN kind as the outer kind (see header).
  // Accept either the collided form (kind === 'click' | ...) or a literal
  // kind:'step' that still carries an inner kind.
  if (STEP_KINDS.includes(msg.kind)) {
    addStepRow(msg.kind, msg);
    return;
  }
  if (msg.kind === 'step') {
    const inner = STEP_KINDS.includes(msg.stepKind) ? msg.stepKind
                : STEP_KINDS.includes(msg.kind2) ? msg.kind2
                : 'plan';
    addStepRow(inner, msg);
    return;
  }

  switch (msg.kind) {
    case 'bridge-status':
      setBridge(!!msg.connected);
      break;
    case 'nano':
      setNano(msg.availability);
      break;
    case 'status':
      setBusy(!!msg.busy);
      if (msg.busy) addProgressLine('(a test is already running — showing live progress)');
      break;
    case 'accepted':
      setBusy(true);
      hideError();
      addProgressLine('Run accepted. Starting…');
      break;
    case 'progress':
      addProgressLine(msg.line);
      break;
    case 'done':
      finalizePendingStep(true);
      setBusy(false);
      renderResult(msg);
      break;
    case 'error':
      finalizePendingStep(false);
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
  refreshRunEnabled();
  runBtn.textContent = value ? 'Testing…' : 'Run test';
  suggestions.querySelectorAll('.suggestion-card').forEach((c) => {
    c.disabled = value;
  });
  if (!value) finalizePendingStep(null);
}

// ---- active-tab tracking ---------------------------------------------------
function isTestableUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

function renderTabCard() {
  if (!activeTab) {
    tabTitle.textContent = 'No active tab';
    tabHost.textContent = '';
    tabFavicon.textContent = '🌐';
    return;
  }
  tabTitle.textContent = activeTab.title || activeTab.url || 'Untitled tab';

  const testable = isTestableUrl(activeTab.url);
  tabHost.textContent = testable ? hostOf(activeTab.url) : (activeTab.url || '');

  // favicon: chrome://favicon is unreliable; use the tab's own favIconUrl and
  // fall back to a generic glyph.
  const fav = activeTab.favIconUrl;
  if (fav && /^https?:\/\//i.test(fav)) {
    tabFavicon.textContent = '';
    const img = document.createElement('img');
    img.src = fav;
    img.alt = '';
    img.addEventListener('error', () => { tabFavicon.textContent = '🌐'; });
    tabFavicon.appendChild(img);
  } else {
    tabFavicon.textContent = '🌐';
  }

  tabWarning.hidden = testable;
  refreshRunEnabled();
}

function refreshRunEnabled() {
  const testable = activeTab && isTestableUrl(activeTab.url);
  runBtn.disabled = busy || !testable;
}

function loadActiveTab() {
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      void chrome.runtime.lastError;
      activeTab = (tabs && tabs[0]) ? tabs[0] : null;
      renderTabCard();
    });
  } catch {
    activeTab = null;
    renderTabCard();
  }
}

try {
  chrome.tabs.onActivated.addListener(() => loadActiveTab());
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    // only react to the tab we're showing, and to meaningful changes
    if (activeTab && tabId === activeTab.id &&
        (info.status || info.url || info.title || info.favIconUrl)) {
      if (tab) { activeTab = tab; renderTabCard(); }
      else loadActiveTab();
    }
  });
} catch { /* tabs events unavailable — static card */ }

// ---- feed: raw progress lines (secondary) ----------------------------------
function addProgressLine(line) {
  if (line === undefined || line === null) return;
  const el = document.createElement('span');
  el.className = 'feed-line progress-line';
  const ts = document.createElement('span');
  ts.className = 'feed-ts';
  ts.textContent = new Date().toLocaleTimeString();
  el.appendChild(ts);
  el.appendChild(document.createTextNode(String(line)));
  feed.appendChild(el);
  feed.scrollTop = feed.scrollHeight;
}

// ---- feed: timeline step rows ----------------------------------------------
function humanize(text, stepKind) {
  const t = (text === undefined || text === null) ? '' : String(text);
  if (t) return t;
  // fallback label if the step carried no text
  switch (stepKind) {
    case 'plan': return 'Planning the next action';
    case 'click': return 'Clicking';
    case 'type': return 'Typing';
    case 'navigate': return 'Navigating';
    case 'assert': return 'Checking the page';
    case 'wait': return 'Waiting';
    case 'finish': return 'Finishing up';
    default: return stepKind;
  }
}

function addStepRow(stepKind, msg) {
  // a new step means the previous in-flight row resolved; leave its tick as-is
  // (the daemon sends ok on the row it pertains to). Clear the spinner from the
  // prior pending row so only the latest shows the live state.
  if (pendingStepRow) clearRowSpinner(pendingStepRow);

  const row = document.createElement('div');
  row.className = 'step-row';

  const icon = document.createElement('span');
  icon.className = 'step-icon';
  icon.textContent = STEP_ICON[stepKind] || '•';
  row.appendChild(icon);

  const textEl = document.createElement('span');
  textEl.className = 'step-text';
  textEl.textContent = humanize(msg.text, stepKind);

  // 'plan' while latest + busy → animated thinking ellipsis
  if (stepKind === 'plan' && busy) {
    const think = document.createElement('span');
    think.className = 'step-think';
    think.appendChild(makeThinkDot());
    think.appendChild(makeThinkDot());
    think.appendChild(makeThinkDot());
    textEl.appendChild(think);
  }
  row.appendChild(textEl);

  // state cell: tick if ok specified, else a spinner while it's the live row
  const state = document.createElement('span');
  if (msg.ok === true) {
    state.className = 'step-state ok';
    state.textContent = '✓';
  } else if (msg.ok === false) {
    state.className = 'step-state bad';
    state.textContent = '✗';
  } else if (busy) {
    state.className = 'step-spinner';
  } else {
    state.className = 'step-state';
  }
  row.appendChild(state);

  feed.appendChild(row);
  feed.scrollTop = feed.scrollHeight;

  // track as pending only if it has no resolved state yet
  pendingStepRow = (msg.ok === true || msg.ok === false) ? null : row;
}

function makeThinkDot() {
  const s = document.createElement('span');
  s.textContent = '.';
  return s;
}

function clearRowSpinner(row) {
  const spinner = row.querySelector('.step-spinner');
  if (spinner) {
    // resolved-but-unknown: neutral check
    spinner.className = 'step-state';
    spinner.textContent = '';
  }
  const think = row.querySelector('.step-think');
  if (think) think.remove();
}

/** Resolve the last in-flight row at run end. ok=true→✓, false→✗, null→neutral. */
function finalizePendingStep(ok) {
  if (!pendingStepRow) return;
  const row = pendingStepRow;
  pendingStepRow = null;
  const think = row.querySelector('.step-think');
  if (think) think.remove();
  const spinner = row.querySelector('.step-spinner');
  if (spinner) {
    if (ok === true) { spinner.className = 'step-state ok'; spinner.textContent = '✓'; }
    else if (ok === false) { spinner.className = 'step-state bad'; spinner.textContent = '✗'; }
    else { spinner.className = 'step-state'; spinner.textContent = ''; }
  }
}

function clearFeed() {
  feed.textContent = '';
  pendingStepRow = null;
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
    addProgressLine(`Done in ${(params.durationMs / 1000).toFixed(1)}s.`);
  } else {
    addProgressLine('Done.');
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
function startRun(task) {
  if (busy) return;
  if (!activeTab || !isTestableUrl(activeTab.url)) {
    showError('Open the page you want to test in this tab (an http/https page).');
    return;
  }
  const t = (task || '').trim();
  if (!t) {
    showError('Tell me what to test first, or tap one of the suggestions above.');
    taskInput.focus();
    return;
  }
  hideError();
  resultCard.hidden = true;
  clearFeed();
  addProgressLine(`Asking the agent to test: ${activeTab.url}`);
  // optimistic; the SW confirms with 'accepted' or 'error'
  setBusy(true);
  postToSW({ kind: 'run', task: t, tabId: activeTab.id, url: activeTab.url });
}

runBtn.addEventListener('click', () => startRun(taskInput.value));

// suggestion cards: fill the textarea AND start immediately
suggestions.addEventListener('click', (ev) => {
  const card = ev.target.closest('.suggestion-card');
  if (!card || card.disabled) return;
  const task = card.getAttribute('data-task') || '';
  taskInput.value = task;
  startRun(task);
});

// ---- initial state + polling ----------------------------------------------
function requestInitialState() {
  postToSW({ kind: 'bridge-status' });
  postToSW({ kind: 'nano' });
  postToSW({ kind: 'status' });
}

loadActiveTab();
requestInitialState();

// poll the bridge connection so the dot stays accurate
setInterval(() => postToSW({ kind: 'bridge-status' }), 3000);
