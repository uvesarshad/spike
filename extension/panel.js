/* Vibe-mode side panel.
 *
 * The non-technical face of the QA subagent: pick a task (or tap a suggestion),
 * watch the run drive THIS tab, get a verdict + a paste-ready fix prompt.
 *
 * Talks ONLY to the service worker over a long-lived chrome.runtime port named
 * 'vibe-panel'. The SW relays our run/status/nano/bridge-status requests to the
 * daemon and broadcasts the daemon's vibe.* events back to us.
 *
 *   panel -> SW : { kind:'run', task, tabId, url, allowHost? }
 *                 { kind:'cancel' }
 *                 { kind:'fix' }
 *                 { kind:'clip' }
 *                 { kind:'nano-download' }
 *                 { kind:'status' }
 *                 { kind:'nano' }
 *                 { kind:'bridge-status' }
 *   SW -> panel : { kind:'accepted', accepted? }
 *                 { kind:'error', message }       (run rejected / daemon down)
 *                 { kind:'cancelled', cancelled }  (relayed vibe.cancel result)
 *                 { kind:'fix-progress', line }    (relayed vibe.fix-progress)
 *                 { kind:'fix-done', ok, agent?, message? } (relayed vibe.fix-done)
 *                 { kind:'nano-progress', status } (download progress)
 *                 { kind:'clip', name, mime, dataBase64 } (last replay clip)
 *                 { kind:'clip-error', message }
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
// step kind → icon name (see icons.js); identity mapping, kept explicit so an
// unknown kind falls back to a neutral dot.
const STEP_ICON = {
  plan: 'plan',
  click: 'click',
  type: 'type',
  navigate: 'navigate',
  assert: 'assert',
  wait: 'wait',
  finish: 'finish',
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
const autoFixBtn = $('autoFixBtn');
const fixStatus = $('fixStatus');
const fixNote = $('fixNote');
const suggestions = $('suggestions');
const tabFavicon = $('tabFavicon');
const tabTitle = $('tabTitle');
const tabHost = $('tabHost');
const tabWarning = $('tabWarning');
const stopBtn = $('stopBtn');
const consentToggle = $('consentToggle');
const consentNote = $('consentNote');
const clipBtn = $('clipBtn');
const nanoOnboard = $('nanoOnboard');
const nanoDownloadBtn = $('nanoDownloadBtn');
const nanoProgress = $('nanoProgress');
const nanoProgressFill = $('nanoProgressFill');
const nanoProgressText = $('nanoProgressText');
const nanoGate = $('nanoGate');
const historySection = $('historySection');
const historyToggle = $('historyToggle');
const historyList = $('historyList');

// settings
const settingsBtn = $('settingsBtn');
const settingsModal = $('settingsModal');
const settingsClose = $('settingsClose');
const settingsCloseBtn = $('settingsCloseBtn');
const settingsSave = $('settingsSave');
// Brain card (the smart planner — cfg.planner)
const setProvider = $('setProvider');
const setModeRow = $('setModeRow');
const setModel = $('setModel');
const setKeyRow = $('setKeyRow');
const setKey = $('setKey');
const setKeySave = $('setKeySave');
const setKeyStatus = $('setKeyStatus');
const setKeyToggle = $('setKeyToggle');
// Navigator card (the cheap per-step model — cfg.navigator; the only card with Nano)
const setNavProvider = $('setNavProvider');
const setNavModeRow = $('setNavModeRow');
const setNavModel = $('setNavModel');
const setNavKeyRow = $('setNavKeyRow');
const setNavKey = $('setNavKey');
const setNavKeySave = $('setNavKeySave');
const setNavKeyStatus = $('setNavKeyStatus');
const setNavKeyToggle = $('setNavKeyToggle');
const setNavNanoNote = $('setNavNanoNote');
const setNavNanoDownload = $('setNavNanoDownload');
const setDebugAgentRow = $('setDebugAgentRow');
const setDebugAgent = $('setDebugAgent');
const themeBtn = $('themeBtn');

// Per-card DOM references, so the settings logic runs once per role. `nanoNote`/
// `nanoDownload` live only on the navigator card (Nano is navigator-only now).
const brainCardRefs = {
  role: 'brain',
  provider: setProvider, modeRow: setModeRow, modeName: 'setMode',
  model: setModel, keyRow: setKeyRow, key: setKey, keyStatus: setKeyStatus,
  nanoNote: null, nanoDownload: null,
};
const navCardRefs = {
  role: 'navigator',
  provider: setNavProvider, modeRow: setNavModeRow, modeName: 'setNavMode',
  model: setNavModel, keyRow: setNavKeyRow, key: setNavKey, keyStatus: setNavKeyStatus,
  nanoNote: setNavNanoNote, nanoDownload: setNavNanoDownload,
};

// last nano availability reported by the SW (drives the settings nano note/button)
let nanoAvailability = null;

// ---- theme (light / dark) --------------------------------------------------
const THEME_KEY = 'qaTheme';
function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  // show the icon of the mode you'll switch TO (sun in dark, moon in light)
  if (themeBtn) themeBtn.innerHTML = qaIcon(t === 'light' ? 'moon' : 'sun');
}
function initTheme() {
  try {
    chrome.storage.local.get(THEME_KEY, (v) => {
      const stored = v && v[THEME_KEY];
      if (stored === 'light' || stored === 'dark') { applyTheme(stored); return; }
      const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
      applyTheme(prefersLight ? 'light' : 'dark');
    });
  } catch {
    applyTheme('dark');
  }
}
if (themeBtn) {
  themeBtn.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    applyTheme(next);
    try { chrome.storage.local.set({ [THEME_KEY]: next }); } catch { /* noop */ }
  });
}

let busy = false;
let fixing = false;
let fetchingClip = false;

// settings: the last config returned by the daemon, and the current debug mode
// (gates the auto-fix button — only shown when the user opted into auto-fix).
let currentConfig = null;
let debugMode = 'prompt';

// the task + verdict of the most recent result (for history persistence)
let lastResult = null; // { task, verdict, reason }

// ---- run history (chrome.storage.local) ------------------------------------
const HISTORY_KEY = 'qaHistory';
const HISTORY_CAP = 10;

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
    case 'cancelled':
      // The run will also emit done/error; handle both orders gracefully —
      // returning to idle here is safe even if the run already finalized.
      finalizePendingStep(null);
      setBusy(false);
      addProgressLine(msg.cancelled === false ? 'Nothing to stop.' : 'Stopped.');
      break;
    case 'fix-progress':
      addFixLine(msg.line);
      break;
    case 'fix-done':
      onFixDone(msg);
      break;
    case 'nano-progress':
      renderNanoProgress(msg.status);
      break;
    case 'clip':
      onClipReceived(msg);
      break;
    case 'clip-error':
      onClipError(msg.message);
      break;
    case 'config':
      currentConfig = msg;
      if (typeof msg.debugMode === 'string') debugMode = msg.debugMode;
      renderSettings(msg);
      break;
    case 'key-saved':
      onKeySaved(msg);
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
  const a = String(availability || '').toLowerCase();
  nanoAvailability = a;
  if (settingsModal && !settingsModal.hidden) refreshSettingsVisibility();
  let text;
  // onboarding sub-elements default hidden; specific states reveal them
  let showOnboard = false;
  let showDownloadBtn = false;
  let showGate = false;

  switch (a) {
    case 'available':
    case 'readily':
      text = 'On-device AI: ready';
      // a completed download leaves the progress visible until flip; clear it
      hideNanoProgress();
      break;
    case 'downloadable':
    case 'after-download':
      text = 'On-device AI: available to download';
      showOnboard = true;
      showDownloadBtn = !nanoDownloading;
      break;
    case 'downloading':
      text = 'On-device AI: downloading — testing still works via cloud free tier';
      showOnboard = true;
      showDownloadBtn = false;
      break;
    case 'unavailable':
      text = 'On-device AI: unavailable — testing still works via cloud free tier';
      showOnboard = true;
      showGate = true;
      break;
    default:
      text = 'On-device AI: unavailable — testing still works via cloud free tier';
      break;
  }
  nanoLine.textContent = text;
  // ready state gets a lime check icon trailing the label
  if (a === 'available' || a === 'readily') {
    const ok = qaIconNode('check');
    if (ok) { ok.classList.add('nano-ok-ico'); nanoLine.append(' ', ok); }
  }

  nanoOnboard.hidden = !showOnboard;
  nanoDownloadBtn.hidden = !showDownloadBtn;
  nanoGate.hidden = !showGate;
}

// ---- nano download / onboarding -------------------------------------------
let nanoDownloading = false;

function renderNanoProgress(status) {
  nanoDownloading = true;
  nanoOnboard.hidden = false;
  nanoDownloadBtn.hidden = true;
  nanoGate.hidden = true;
  nanoProgress.hidden = false;

  const s = status || {};
  // status may carry { loaded, total } bytes and/or a state string.
  let pct = null;
  if (typeof s.loaded === 'number' && typeof s.total === 'number' && s.total > 0) {
    pct = Math.max(0, Math.min(100, Math.round((s.loaded / s.total) * 100)));
  } else if (typeof s.progress === 'number') {
    // progress may be 0..1 or 0..100
    pct = s.progress <= 1 ? Math.round(s.progress * 100) : Math.round(s.progress);
    pct = Math.max(0, Math.min(100, pct));
  }

  if (pct !== null) {
    nanoProgressFill.style.width = pct + '%';
    nanoProgressText.textContent = `Downloading on-device AI… ${pct}%`;
  } else {
    // indeterminate — show a label, keep last width
    nanoProgressText.textContent = s.state
      ? `Downloading on-device AI… (${s.state})`
      : 'Downloading on-device AI…';
  }
  nanoLine.textContent = 'On-device AI: downloading — testing still works via cloud free tier';
}

function hideNanoProgress() {
  nanoDownloading = false;
  nanoProgress.hidden = true;
  nanoProgressFill.style.width = '0%';
  nanoProgressText.textContent = '';
}

nanoDownloadBtn.addEventListener('click', () => {
  nanoDownloading = true;
  nanoDownloadBtn.hidden = true;
  nanoGate.hidden = true;
  nanoProgress.hidden = false;
  nanoProgressText.textContent = 'Starting download…';
  postToSW({ kind: 'nano-download' });
});

// ---- busy / run button -----------------------------------------------------
function setBusy(value) {
  busy = value;
  refreshRunEnabled();
  runBtn.textContent = value ? 'Testing…' : 'Run test';
  stopBtn.hidden = !value;
  stopBtn.disabled = false;
  stopBtn.textContent = 'Stop';
  suggestions.querySelectorAll('.suggestion-card').forEach((c) => {
    c.disabled = value;
  });
  if (!value) finalizePendingStep(null);
}

// ---- stop / cancel ---------------------------------------------------------
stopBtn.addEventListener('click', () => {
  if (!busy) return;
  stopBtn.disabled = true;
  stopBtn.textContent = 'Stopping…';
  addProgressLine('Stopping the test…');
  postToSW({ kind: 'cancel' });
});

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
    tabFavicon.innerHTML = qaIcon('globe');
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
    img.addEventListener('error', () => { tabFavicon.innerHTML = qaIcon('globe'); });
    tabFavicon.appendChild(img);
  } else {
    tabFavicon.innerHTML = qaIcon('globe');
  }

  tabWarning.hidden = testable;
  refreshConsent();
  refreshRunEnabled();
}

// ---- interaction consent ---------------------------------------------------
function isLocalHost(host) {
  return host === 'localhost' || host === '127.0.0.1' ||
    host === '[::1]' || /^localhost:/.test(host) || /^127\.0\.0\.1:/.test(host);
}

/** Default-checked for every testable host; third-party (non-localhost) hosts
 * keep the box checked but get an amber "interacts as you" note. */
function refreshConsent() {
  const testable = activeTab && isTestableUrl(activeTab.url);
  if (!testable) {
    consentNote.hidden = true;
    return;
  }
  const host = hostOf(activeTab.url);
  // default checked (set once per tab render; the user can still uncheck)
  consentToggle.checked = true;
  if (isLocalHost(host)) {
    consentNote.hidden = true;
  } else {
    consentNote.hidden = false;
    consentNote.textContent = 'third-party site — the agent will interact with it as you';
  }
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

// ---- feed: auto-fix progress lines (distinct style) ------------------------
function addFixLine(line) {
  if (line === undefined || line === null) return;
  const el = document.createElement('span');
  el.className = 'feed-line fix-line';
  const ts = document.createElement('span');
  ts.className = 'feed-ts';
  ts.textContent = new Date().toLocaleTimeString();
  el.appendChild(ts);
  const wr = qaIconNode('wrench');
  if (wr) { wr.classList.add('fix-line-ico'); el.appendChild(wr); }
  el.appendChild(document.createTextNode(' ' + String(line)));
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
  icon.innerHTML = qaIcon(STEP_ICON[stepKind] || 'dot');
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
    state.innerHTML = qaIcon('check');
  } else if (msg.ok === false) {
    state.className = 'step-state bad';
    state.innerHTML = qaIcon('x');
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
    if (ok === true) { spinner.className = 'step-state ok'; spinner.innerHTML = qaIcon('check'); }
    else if (ok === false) { spinner.className = 'step-state bad'; spinner.innerHTML = qaIcon('x'); }
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
  let vIcon, vLabel;
  if (verdict === 'pass') {
    verdictBadge.classList.add('verdict-pass');
    vIcon = 'pass'; vLabel = 'PASS';
  } else if (verdict === 'fail') {
    verdictBadge.classList.add('verdict-fail');
    vIcon = 'fail'; vLabel = 'FAIL';
  } else {
    verdictBadge.classList.add('verdict-uncertain');
    vIcon = 'uncertain'; vLabel = 'UNCERTAIN';
  }
  verdictBadge.innerHTML = qaIcon(vIcon) + '<span>' + vLabel + '</span>';

  const reportText = params.plainReport || params.reason || '(no report)';
  plainReport.textContent = reportText;

  // a saved replay clip (clipPath in the done payload) → offer a download
  if (params.clipPath) {
    clipBtn.hidden = false;
    clipBtn.disabled = false;
    clipBtn.innerHTML = qaIcon('download') + '<span>Download clip</span>';
  } else {
    clipBtn.hidden = true;
  }

  const fix = (params.fixPrompt || '').trim();
  if (fix) {
    fixPrompt.value = fix;
    fixSection.hidden = false;
    resetCopyBtn();
    // auto-fix is only meaningful on a non-pass verdict that produced a fix
    // prompt AND the user opted into auto-fix in Settings (else paste-a-prompt).
    resetFixUi();
    autoFixBtn.hidden = (verdict === 'pass') || debugMode !== 'auto';
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

  // persist to run history
  lastResult = {
    task: (taskInput.value || '').trim(),
    verdict,
    reason: reportText,
  };
  void saveHistory(lastResult);
}

// ---- copy fix prompt -------------------------------------------------------
let copyTimer = null;
function resetCopyBtn() {
  copyBtn.classList.remove('copied');
  copyBtn.textContent = 'Copy';
}
function flashCopied() {
  copyBtn.classList.add('copied');
  copyBtn.innerHTML = qaIcon('check') + '<span>Copied</span>';
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

// ---- download clip ---------------------------------------------------------
clipBtn.addEventListener('click', () => {
  if (fetchingClip) return;
  fetchingClip = true;
  clipBtn.disabled = true;
  clipBtn.textContent = 'Preparing…';
  postToSW({ kind: 'clip' });
});

function base64ToBlob(base64, mime) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime || 'application/octet-stream' });
}

function onClipReceived(msg) {
  fetchingClip = false;
  clipBtn.disabled = false;
  clipBtn.innerHTML = qaIcon('download') + '<span>Download clip</span>';
  if (!msg || !msg.dataBase64) {
    onClipError('no clip data returned');
    return;
  }
  try {
    const blob = base64ToBlob(msg.dataBase64, msg.mime);
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = msg.name || 'replay.webm';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // revoke after the click has had a chance to start the download
    setTimeout(() => { try { URL.revokeObjectURL(objUrl); } catch { /* noop */ } }, 4000);
  } catch (e) {
    onClipError(String(e && e.message ? e.message : e));
  }
}

function onClipError(message) {
  fetchingClip = false;
  clipBtn.disabled = false;
  clipBtn.innerHTML = qaIcon('download') + '<span>Download clip</span>';
  showError('Could not download the clip: ' + (message || 'unknown error'));
}

// ---- auto-fix --------------------------------------------------------------
function resetFixUi() {
  fixing = false;
  autoFixBtn.hidden = false;
  autoFixBtn.disabled = false;
  autoFixBtn.innerHTML = qaIcon('sparkles') + '<span>Auto-fix with my coding agent</span>';
  fixStatus.hidden = true;
  fixStatus.textContent = '';
  fixNote.hidden = true;
  fixNote.textContent = '';
}

autoFixBtn.addEventListener('click', () => {
  if (fixing) return;
  fixing = true;
  autoFixBtn.disabled = true;
  autoFixBtn.textContent = 'Fixing…';
  fixNote.hidden = true;
  fixStatus.hidden = false;
  fixStatus.textContent = 'Handing the fix to your coding agent…';
  hideError();
  // keep the suggestion cards / run disabled while a fix is in flight
  suggestions.querySelectorAll('.suggestion-card').forEach((c) => { c.disabled = true; });
  runBtn.disabled = true;
  addFixLine('Starting auto-fix…');
  postToSW({ kind: 'fix' });
});

function onFixDone(msg) {
  fixing = false;
  // re-enable run + suggestions (respecting tab testability)
  suggestions.querySelectorAll('.suggestion-card').forEach((c) => { c.disabled = false; });
  refreshRunEnabled();

  if (msg && msg.ok) {
    const agent = msg.agent ? String(msg.agent) : 'your coding agent';
    autoFixBtn.hidden = true;
    fixStatus.hidden = true;
    fixNote.hidden = false;
    fixNote.textContent = `Fix applied by ${agent} — run the test again to verify`;
    addFixLine(`Fix applied by ${agent}.`);
  } else {
    // failure → error banner with the message; re-enable the button to retry
    autoFixBtn.disabled = false;
    autoFixBtn.innerHTML = qaIcon('sparkles') + '<span>Auto-fix with my coding agent</span>';
    fixStatus.hidden = true;
    const m = (msg && msg.message) ? String(msg.message) : 'Auto-fix failed.';
    showError(m);
    addFixLine('Auto-fix failed: ' + m);
  }
}

// ---- settings --------------------------------------------------------------
//
// The Settings modal lets the user pick the browsing-control AI (provider + API/
// CLI mode + model + API key) and a debugging mode (paste-a-prompt vs auto-fix +
// which coding agent). State lives on the daemon; we fetch it with config-get,
// save with config-set, and manage keys with set-key/clear-key. The SW replies
// with a fresh { kind:'config', ... } we render here.

/** The provider currently selected in the Brain card. */
function selectedProvider() {
  return setProvider.value;
}
/** The provider currently selected in the Navigator card. */
function selectedNavProvider() {
  return setNavProvider.value;
}

/** The provider descriptor (from config.providers) for a provider id. */
function providerInfo(id) {
  const list = (currentConfig && Array.isArray(currentConfig.providers)) ? currentConfig.providers : [];
  return list.find((p) => p && p.id === id) || null;
}

/** The mode (api/cli/ondevice) chosen for a card, clamped to what its provider
 * supports. `provider` is the card's selected provider; `radioName` its radio group. */
function chosenMode(provider, radioName) {
  const info = providerInfo(provider);
  const modes = (info && Array.isArray(info.modes)) ? info.modes : [];
  if (modes.length === 0) return 'api';
  const checked = settingsModal.querySelector(`input[name="${radioName}"]:checked`);
  const want = checked ? checked.value : null;
  if (want && modes.includes(want)) return want;
  // single-mode providers (nano=ondevice, ollama/openrouter=api) → that mode
  return modes[0];
}

/** Brain-card mode (api/cli). */
function selectedMode() {
  return chosenMode(selectedProvider(), 'setMode');
}
/** Navigator-card mode (api/cli/ondevice). */
function selectedNavMode() {
  return chosenMode(selectedNavProvider(), 'setNavMode');
}
/** Navigator-card model text. */
function selectedNavModel() {
  return setNavModel.value.trim();
}

/** The debug mode currently chosen in the form. */
function selectedDebugMode() {
  const checked = settingsModal.querySelector('input[name="setDebugMode"]:checked');
  return checked ? checked.value : 'prompt';
}

/** Placeholder/default model for a provider, preferring the role-specific default
 * (navModelDefault / brainModelDefault) then falling back to the mode default. */
function defaultModelFor(info, mode, role) {
  if (!info) return 'default model';
  if (role === 'navigator' && info.navModelDefault) return info.navModelDefault;
  if (role === 'brain' && info.brainModelDefault) return info.brainModelDefault;
  if (mode === 'cli') return info.cliModelDefault || 'default model';
  return info.apiModelDefault || 'default model';
}

/** Show/hide the mode radios, key row, model placeholder and (nav-only) nano
 * note/download for ONE card, per its current selection. */
function refreshCardVisibility(refs) {
  const provider = refs.provider.value;
  const info = providerInfo(provider);
  const modes = (info && Array.isArray(info.modes)) ? info.modes : [];

  // mode radios: hide entirely for single-mode providers (nano, ollama, openrouter)
  const hasApi = modes.includes('api');
  const hasCli = modes.includes('cli');
  const showModes = hasApi && hasCli;
  refs.modeRow.hidden = !showModes;
  refs.modeRow.querySelectorAll(`input[name="${refs.modeName}"]`).forEach((el) => {
    if (el.value === 'api') el.disabled = !hasApi;
    if (el.value === 'cli') el.disabled = !hasCli;
  });

  const mode = chosenMode(provider, refs.modeName);

  // key row: only when the provider needs a key AND we're in API mode
  const needsKey = !!(info && info.needsKey);
  const showKey = needsKey && mode === 'api';
  refs.keyRow.hidden = !showKey;

  // model placeholder reflects the role-specific / mode default
  refs.model.placeholder = defaultModelFor(info, mode, refs.role);

  // key status from providers[].hasKey
  if (showKey) {
    refs.keyStatus.classList.remove('err');
    refs.keyStatus.textContent = (info && info.hasKey) ? 'saved ✓' : '';
  }

  // Gemini Nano: on-device note + one-time download prompt (navigator card only).
  if (refs.nanoNote || refs.nanoDownload) {
    const isNano = provider === 'nano';
    if (refs.nanoNote) refs.nanoNote.hidden = !isNano;
    if (refs.nanoDownload) {
      const ready = nanoAvailability === 'available' || nanoAvailability === 'readily';
      refs.nanoDownload.hidden = !isNano || ready || nanoDownloading;
    }
  }
}

/** Refresh BOTH settings cards + the debug agent row. Called on open and whenever
 * provider/mode/debug-mode change. */
function refreshSettingsVisibility() {
  refreshCardVisibility(navCardRefs);
  refreshCardVisibility(brainCardRefs);

  // agent select only when auto-fix is chosen
  setDebugAgentRow.hidden = selectedDebugMode() !== 'auto';
}

/** Populate the whole form from a daemon config payload. */
function renderSettings(cfg) {
  if (!cfg) return;
  const planner = cfg.planner || {};   // BRAIN role
  const navi = cfg.navigator || {};     // NAVIGATOR role

  // Brain card: provider select
  if (planner.provider) setProvider.value = planner.provider;

  // Brain card: mode radios (respect the saved mode; visibility handled below)
  const wantMode = planner.mode || 'api';
  setModeRow.querySelectorAll('input[name="setMode"]').forEach((el) => {
    el.checked = (el.value === wantMode);
  });

  // Brain card: model value
  setModel.value = planner.model || '';

  // Navigator card: provider select
  if (navi.provider) setNavProvider.value = navi.provider;

  // Navigator card: mode radios
  const wantNavMode = navi.mode || 'ondevice';
  setNavModeRow.querySelectorAll('input[name="setNavMode"]').forEach((el) => {
    el.checked = (el.value === wantNavMode);
  });

  // Navigator card: model value
  setNavModel.value = navi.model || '';

  // debug mode radios
  const wantDebug = cfg.debugMode || 'prompt';
  settingsModal.querySelectorAll('input[name="setDebugMode"]').forEach((el) => {
    el.checked = (el.value === wantDebug);
  });

  // debug agent
  if (cfg.debugAgent) setDebugAgent.value = cfg.debugAgent;

  refreshSettingsVisibility();
}

function onKeySaved(msg) {
  if (!msg) return;
  // reflect hasKey locally so a re-render keeps the status accurate
  if (msg.ok) {
    const info = providerInfo(msg.provider);
    if (info) info.hasKey = !msg.cleared;
  }
  // A provider's key is shared across cards — update every card showing it.
  for (const refs of [navCardRefs, brainCardRefs]) {
    if (refs.provider.value !== msg.provider) continue;
    if (msg.ok) {
      refs.keyStatus.classList.remove('err');
      refs.keyStatus.textContent = msg.cleared ? '' : 'saved ✓';
      // keep the key in the field (persistent) — the user can reveal it with the
      // eye toggle to confirm; clear it only when the key was removed.
      if (msg.cleared) refs.key.value = '';
    } else {
      refs.keyStatus.classList.add('err');
      refs.keyStatus.textContent = msg.message ? ('error: ' + msg.message) : 'could not save key';
    }
  }
}

// show / hide the API key (one eye toggle per card)
function wireKeyToggle(toggle, input) {
  if (!toggle) return;
  toggle.addEventListener('click', () => {
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    toggle.innerHTML = qaIcon(reveal ? 'eye-off' : 'eye');
  });
}
wireKeyToggle(setKeyToggle, setKey);
wireKeyToggle(setNavKeyToggle, setNavKey);

function openSettings() {
  settingsModal.hidden = false;
  postToSW({ kind: 'config-get' });
}

function closeSettings() {
  settingsModal.hidden = true;
}

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsCloseBtn.addEventListener('click', closeSettings);
// click the dimmed backdrop (outside the card) to dismiss
settingsModal.addEventListener('click', (ev) => {
  if (ev.target === settingsModal) closeSettings();
});
// settings-side "Download on-device AI" (navigator card) — reuses the SW nano-download flow
if (setNavNanoDownload) {
  setNavNanoDownload.addEventListener('click', () => {
    setNavNanoDownload.hidden = true;
    postToSW({ kind: 'nano-download' });
  });
}

setProvider.addEventListener('change', refreshSettingsVisibility);
setNavProvider.addEventListener('change', refreshSettingsVisibility);
setModeRow.querySelectorAll('input[name="setMode"]').forEach((el) => {
  el.addEventListener('change', refreshSettingsVisibility);
});
setNavModeRow.querySelectorAll('input[name="setNavMode"]').forEach((el) => {
  el.addEventListener('change', refreshSettingsVisibility);
});
settingsModal.querySelectorAll('input[name="setDebugMode"]').forEach((el) => {
  el.addEventListener('change', refreshSettingsVisibility);
});

// Save key — one handler per card; keys are stored per-provider (shared across cards).
setKeySave.addEventListener('click', () => {
  const key = setKey.value.trim();
  if (!key) return;
  setKeyStatus.classList.remove('err');
  setKeyStatus.textContent = 'saving…';
  postToSW({ kind: 'set-key', provider: selectedProvider(), key });
});
setNavKeySave.addEventListener('click', () => {
  const key = setNavKey.value.trim();
  if (!key) return;
  setNavKeyStatus.classList.remove('err');
  setNavKeyStatus.textContent = 'saving…';
  postToSW({ kind: 'set-key', provider: selectedNavProvider(), key });
});

settingsSave.addEventListener('click', () => {
  postToSW({
    kind: 'config-set',
    planner: {
      provider: selectedProvider(),
      mode: selectedMode(),
      model: setModel.value.trim(),
    },
    navigator: {
      provider: selectedNavProvider(),
      mode: selectedNavMode(),
      model: selectedNavModel(),
    },
    debugMode: selectedDebugMode(),
    debugAgent: setDebugAgent.value,
  });
  closeSettings();
});

// ---- run history (chrome.storage.local) ------------------------------------
function relativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function verdictIconName(verdict) {
  switch (String(verdict || '').toLowerCase()) {
    case 'pass': return 'pass';
    case 'fail': return 'fail';
    default: return 'uncertain';
  }
}

function loadHistory() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(HISTORY_KEY, (res) => {
        void chrome.runtime.lastError;
        const arr = res && Array.isArray(res[HISTORY_KEY]) ? res[HISTORY_KEY] : [];
        resolve(arr);
      });
    } catch {
      resolve([]);
    }
  });
}

async function saveHistory(result) {
  if (!result) return;
  const entry = {
    ts: Date.now(),
    task: String(result.task || '').slice(0, 80),
    verdict: result.verdict,
    reason: String(result.reason || '').slice(0, 120),
  };
  const list = await loadHistory();
  list.unshift(entry);
  const capped = list.slice(0, HISTORY_CAP);
  try {
    chrome.storage.local.set({ [HISTORY_KEY]: capped }, () => { void chrome.runtime.lastError; });
  } catch { /* storage unavailable — non-fatal */ }
  renderHistory(capped);
}

function renderHistory(list) {
  historyList.textContent = '';
  if (!list || list.length === 0) {
    historySection.hidden = true;
    return;
  }
  historySection.hidden = false;
  for (const item of list) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'history-item';

    const emoji = document.createElement('span');
    emoji.className = 'history-emoji ' + verdictIconName(item.verdict);
    emoji.innerHTML = qaIcon(verdictIconName(item.verdict));
    row.appendChild(emoji);

    const task = document.createElement('span');
    task.className = 'history-task';
    task.textContent = item.task || '(no task)';
    task.title = item.reason || '';
    row.appendChild(task);

    const time = document.createElement('span');
    time.className = 'history-time';
    time.textContent = relativeTime(item.ts);
    row.appendChild(time);

    // clicking re-fills the task textarea (no auto-run)
    row.addEventListener('click', () => {
      taskInput.value = item.task || '';
      taskInput.focus();
    });

    historyList.appendChild(row);
  }
}

historyToggle.addEventListener('click', () => {
  const open = historyToggle.getAttribute('aria-expanded') === 'true';
  historyToggle.setAttribute('aria-expanded', String(!open));
  historyList.hidden = open;
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
  resetFixUi();
  clearFeed();
  addProgressLine(`Asking the agent to test: ${activeTab.url}`);
  // optimistic; the SW confirms with 'accepted' or 'error'
  setBusy(true);
  const runMsg = { kind: 'run', task: t, tabId: activeTab.id, url: activeTab.url };
  // Consent: when the user allows interaction, pass the tab's host so the daemon
  // adds it to allowedHosts. Unchecked → omit, and the read-only guard applies.
  if (consentToggle.checked) {
    const host = hostOf(activeTab.url);
    if (host) runMsg.allowHost = host;
  }
  postToSW(runMsg);
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
  // fetch the planner/debug config so debugMode is known before the first result
  postToSW({ kind: 'config-get' });
}

initTheme();
loadActiveTab();
requestInitialState();
void loadHistory().then(renderHistory);

// poll the bridge connection so the dot stays accurate
setInterval(() => postToSW({ kind: 'bridge-status' }), 3000);
