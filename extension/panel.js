/* Vibe-mode side panel.
 *
 * The non-technical face of the QA subagent: pick a task (or tap a suggestion),
 * watch the run drive THIS tab, get a verdict + a paste-ready fix prompt.
 *
 * Talks ONLY to the service worker over a long-lived chrome.runtime port named
 * 'vibe-panel'. The SW relays our run/status/nano/bridge-status requests to the
 * daemon and broadcasts the daemon's vibe.* events back to us.
 *
 *   panel -> SW : { kind:'run', task, tabId, url, allowHost?, allowHosts? }
 *                 { kind:'decompose', spec, url }  (A7: document → flow list)
 *                 { kind:'artifact', path }        (A15: fetch one screenshot)
 *                 { kind:'bundle' }                (A15: everything, zipped)
 *                 { kind:'cancel' }
 *                 { kind:'fix' }
 *                 { kind:'clip' }
 *                 { kind:'nano-download' }
 *                 { kind:'status', tabId? }
 *                 { kind:'nano' }
 *                 { kind:'bridge-status' }
 *                 { kind:'map-get', host }       (A51: read-only site-map summary)
 *                 { kind:'coverage-get', host }  (A51: read-only coverage breakdown)
 *   SW -> panel : { kind:'accepted', accepted? }
 *                 { kind:'error', message }       (run rejected / daemon down)
 *                 { kind:'cancelled', cancelled }  (relayed vibe.cancel result)
 *                 { kind:'fix-progress', line }    (relayed vibe.fix-progress)
 *                 { kind:'fix-done', ok, agent?, message? } (relayed vibe.fix-done)
 *                 { kind:'nano-progress', status } (download progress)
 *                 { kind:'clip', name, mime, dataBase64 } (last replay clip)
 *                 { kind:'clip-error', message }
 *                 { kind:'status', busy, orphanedRun? }
 *                   (A10: orphanedRun = {runId, startedAt, task} of a test
 *                   Chrome interrupted by putting the extension to sleep)
 *                 { kind:'nano', availability }
 *                 { kind:'bridge-status', connected, protocolVersion, compatible }
 *                   (A4: protocolVersion/compatible are null until the daemon
 *                   acks the handshake or a timeout resolves it; compatible
 *                   false means "connected but too old — show update UI")
 *                 { kind:'progress', line }       (relayed vibe.progress)
 *                 { kind:'done', ...verdict }     (relayed vibe.done)
 *                 { kind:'done', ...verdict, restored:true, task, bundle }
 *                   (A10: the last finished result, replayed on connect/status
 *                   so closing this panel mid-test no longer loses it)
 *                 { kind:'history', entries }     (A10: the "recent tests" list,
 *                   written by the SW when a test finishes — even with no panel;
 *                   A19: each entry also carries the slim report, so reopening a
 *                   row re-shows the result instead of starting a new test)
 *                 { kind:'tests', tests }         (A19: the saved tests recorded
 *                   for this site — relayed vibe.tests.list; empty with no helper)
 *                 { kind:'error', message }       (relayed vibe.error)
 *                 { kind:<plan|click|type|navigate|assert|wait|finish>,
 *                   index, text, ok? }            (relayed vibe.step — see below)
 *                 { kind:'map', present, routeCount?, stateCount?, lastMappedAt?,
 *                   baseUrl? }                    (A51: relayed vibe.map.get)
 *                 { kind:'coverage', present, routes?, interactiveElements?,
 *                   perRoute? }                   (A51: relayed vibe.coverage.get)
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
const bridgeUpdateNote = $('bridgeUpdateNote');
// A20: the neutral header chip shown until a desktop helper has ever connected.
const liteChip = $('liteChip');
// A20: the one-line explanation of Chrome's debugging bar, under Run.
const debugBarNote = $('debugBarNote');
const nanoLine = $('nanoLine');
const taskInput = $('task');
const runBtn = $('runBtn');
const errorBanner = $('errorBanner');
const feed = $('feed');
const resultCard = $('resultCard');
const verdictBadge = $('verdictBadge');
const plainReport = $('plainReport');
const plainReportFooter = $('plainReportFooter');
const fixSection = $('fixSection');
const fixPrompt = $('fixPrompt');
const copyBtn = $('copyBtn');
const autoFixBtn = $('autoFixBtn');
const confirmModal = $('confirmModal');
const confirmModalBody = $('confirmModalBody');
const confirmCancel = $('confirmCancel');
const confirmOk = $('confirmOk');
const fixStatus = $('fixStatus');
const fixNote = $('fixNote');
const suggestions = $('suggestions');
const tabFavicon = $('tabFavicon');
const tabTitle = $('tabTitle');
const tabHost = $('tabHost');
const tabWarning = $('tabWarning');
const stopBtn = $('stopBtn');
const consentToggle = $('consentToggle');
// A26: the login suggestion, shown only once a test login is saved.
const suggestLoginCard = $('suggestLoginCard');
// A25: "Remember my login for tests" (desktop-helper only).
const rememberLoginRow = $('rememberLoginRow');
const rememberLogin = $('rememberLogin');
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
// A51: "Site map" card — read-only summary of `.spike/app-model.json` (built
// by `spike map`/`spike coverage`) for the current tab's host.
// A19: the "Saved tests" card (desktop-helper only — the tests are its files).
const savedTestsSection = $('savedTestsSection');
const savedTestsToggle = $('savedTestsToggle');
const savedTestsList = $('savedTestsList');
const savedTestsCount = $('savedTestsCount');
const siteMapSection = $('siteMapSection');
const siteMapToggle = $('siteMapToggle');
const siteMapBody = $('siteMapBody');
const siteMapContent = $('siteMapContent');

// A7: document mode — the "Paste a document" toggle, the derived flow
// checklist, and the per-flow verdict rows in the result card.
const modeTaskBtn = $('modeTaskBtn');
const modeDocBtn = $('modeDocBtn');
const suggestWrap = $('suggestWrap');
const taskLabel = $('taskLabel');
const flowsCard = $('flowsCard');
const flowsNote = $('flowsNote');
const flowsList = $('flowsList');
const flowsRunBtn = $('flowsRunBtn');
const flowsCancelBtn = $('flowsCancelBtn');
const flowResults = $('flowResults');
const checkSiteBtn = $('checkSiteBtn');
const checkSiteNote = $('checkSiteNote');

// A14: the plain-English "what happened / whose problem / what to do" block
// under the verdict badge, plus the one-click cross-site consent button.
const verdictWhy = $('verdictWhy');
const verdictHeadline = $('verdictHeadline');
const verdictFault = $('verdictFault');
const verdictNext = $('verdictNext');
const allowHostBtn = $('allowHostBtn');

// A15: the screenshot in the result card.
const shotWrap = $('shotWrap');
const shotImg = $('shotImg');
const shotCaption = $('shotCaption');
const bundleBtn = $('bundleBtn');

// settings
const settingsBtn = $('settingsBtn');
const settingsModal = $('settingsModal');
const settingsSave = $('settingsSave');
// Brain card (the smart planner — cfg.planner)
const setSameAsNav = $('setSameAsNav');
const setBrainFields = $('setBrainFields');
const setSameAsNavNote = $('setSameAsNavNote');
const setSameAsNavNoteText = $('setSameAsNavNoteText');
const setProvider = $('setProvider');
const setModeRow = $('setModeRow');
const setModel = $('setModel');
const setKeyRow = $('setKeyRow');
const setKey = $('setKey');
const setKeySave = $('setKeySave');
const setKeyStatus = $('setKeyStatus');
const setKeyRemove = $('setKeyRemove');
const setKeyToggle = $('setKeyToggle');
// Navigator card (the cheap per-step model — cfg.navigator; the only card with Nano)
const setNavProvider = $('setNavProvider');
const setNavModeRow = $('setNavModeRow');
const setNavModel = $('setNavModel');
const setNavKeyRow = $('setNavKeyRow');
const setNavKey = $('setNavKey');
const setNavKeySave = $('setNavKeySave');
const setNavKeyStatus = $('setNavKeyStatus');
const setNavKeyRemove = $('setNavKeyRemove');
const setNavKeyToggle = $('setNavKeyToggle');
const setNavNanoNote = $('setNavNanoNote');
const setNavNanoDownload = $('setNavNanoDownload');
const setDebugAgentRow = $('setDebugAgentRow');
const setProjectFolderRow = $('setProjectFolderRow');
const setProjectFolder = $('setProjectFolder');
const setAutoFixRow = $('setAutoFixRow');
const noFixAgentNote = $('noFixAgentNote');
const setDebugAgent = $('setDebugAgent');
const setAutoFix = $('setAutoFix');
const setVideoAssert = $('setVideoAssert');
const setSpendCap = $('setSpendCap');
const setStrictOracles = $('setStrictOracles');
const setTestUser = $('setTestUser');
const setTestPassword = $('setTestPassword');
const setTestPasswordToggle = $('setTestPasswordToggle');
const setTestLoginSave = $('setTestLoginSave');
const setTestLoginStatus = $('setTestLoginStatus');
const setTestLoginClear = $('setTestLoginClear');
const setAutoFixNote = $('setAutoFixNote');
const setAutoFixNoteText = $('setAutoFixNoteText');
const connectApp = $('connectApp');
const connectAppTitle = $('connectAppTitle');
const connectAppSub = $('connectAppSub');
const connectAppInstallUi = $('connectAppInstallUi');
const connectCmd = $('connectCmd');
const connectCopy = $('connectCopy');
const connectNpmToggle = $('connectNpmToggle');
const themeBtn = $('themeBtn');

// One-line installer commands per OS. The install scripts are served straight
// from the repo over GitHub Raw ($0, static, no backend) — the daemon then runs
// on the user's OWN machine (localhost:9410); nothing is hosted server-side.
// Swap INSTALL_BASE for a custom domain (Cloudflare/GitHub Pages) later if you
// want a prettier URL; the raw form works the moment the repo is pushed.
const INSTALL_BASE = 'https://raw.githubusercontent.com/uvesarshad/spike/main/install';
const INSTALL_CMDS = {
  win: `irm ${INSTALL_BASE}/install.ps1 | iex`,
  mac: `curl -fsSL ${INSTALL_BASE}/install.sh | sh`,
  linux: `curl -fsSL ${INSTALL_BASE}/install.sh | sh`,
};
// Fallback shown if you'd rather not pipe a remote script — pure npm, no host.
const INSTALL_CMDS_NPM = {
  win: 'npm i -g spike-agent; spike daemon --install-service',
  mac: 'npm i -g spike-agent && spike daemon --install-service',
  linux: 'npm i -g spike-agent && spike daemon --install-service',
};
let connectOs = 'win';
// which command set the card is showing: the Raw-script one-liner or the npm form
let connectUseNpm = false;

// Same one-liner re-runs cleanly to update an existing install (A4: the panel
// swaps to this copy when the daemon IS connected but the protocol handshake
// says it's too old — "install" copy would be misleading in that state).
const CONNECT_APP_COPY = {
  install: {
    title: 'Connect Spike Core',
    sub: 'Run this once in a terminal — the daemon then auto-starts on every login and this panel connects on its own.',
  },
  update: {
    title: 'Update Spike Core',
    sub: "Spike Core is out of date and can't run tests reliably with this version of the extension. Re-run the installer below to update it.",
  },
};
function connectCmds() { return connectUseNpm ? INSTALL_CMDS_NPM : INSTALL_CMDS; }

// A3 (P0): the repo isn't public / the package isn't published yet, so
// INSTALL_BASE 404s today — showing a copyable one-liner that fails is worse
// than showing nothing. Probe reachability once per panel session (cached;
// never re-probed on every render) and gate the install command on it. Any
// file under INSTALL_BASE would do — install.sh is the one every platform's
// one-liner ultimately fetches (directly, or via install.ps1 alongside it).
let installReachable = null; // null = not yet known, true/false once probed
let installProbeStarted = false;
function probeInstallReachable() {
  if (installProbeStarted) return;
  installProbeStarted = true;
  fetch(`${INSTALL_BASE}/install.sh`, { method: 'HEAD' })
    .then((res) => { installReachable = Boolean(res && res.ok); })
    .catch(() => { installReachable = false; })
    .then(() => refreshAutoFixGate());
}

// settings accordions: head button ↔ body element (+ optional summary chip)
const ACCORDIONS = [
  { head: $('accNavHead'), body: $('accNavBody'), summary: $('accNavSummary') },
  { head: $('accBrainHead'), body: $('accBrainBody'), summary: $('accBrainSummary') },
  { head: $('accLoginHead'), body: $('accLoginBody'), summary: $('accLoginSummary') },
  { head: $('accDebugHead'), body: $('accDebugBody'), summary: $('accDebugSummary') },
];

// Per-card DOM references, so the settings logic runs once per role. `nanoNote`/
// `nanoDownload` live only on the navigator card (Nano is navigator-only now).
// `savedStamp`/`saving` are the A4 key-persistence bookkeeping (see
// saveKeyFromCard): the provider+key we last sent, and whether its reply is
// still outstanding.
const brainCardRefs = {
  role: 'brain',
  provider: setProvider, modeRow: setModeRow, modeName: 'setMode',
  model: setModel, keyRow: setKeyRow, key: setKey, keyStatus: setKeyStatus, keyRemove: setKeyRemove,
  nanoNote: null, nanoDownload: null,
  savedStamp: null, saving: false,
};
const navCardRefs = {
  role: 'navigator',
  provider: setNavProvider, modeRow: setNavModeRow, modeName: 'setNavMode',
  model: setNavModel, keyRow: setNavKeyRow, key: setNavKey, keyStatus: setNavKeyStatus, keyRemove: setNavKeyRemove,
  nanoNote: setNavNanoNote, nanoDownload: setNavNanoDownload,
  savedStamp: null, saving: false,
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
// whether Spike Core is currently connected at the socket level.
let bridgeConnected = false;
// A4 protocol handshake result: true | false | null (null = not yet resolved).
// false means the socket is up but the daemon is too old to speak our
// protocol — see setBridge() below and sw.js's bridge.hello handling.
let bridgeCompatible = null;
let bridgeProtocolVersion = null;

/** Gates auto-fix and the download-clip button, both daemon-only capabilities:
 * connected AND not flagged incompatible. A daemon we can't confirm as
 * healthy must not be treated as usable, even though its socket is open. */
function bridgeHealthy() {
  return bridgeConnected && bridgeCompatible !== false;
}

// settings: the last config returned by the daemon, and the current debug mode
// (gates the auto-fix button — only shown when the user opted into auto-fix).
let currentConfig = null;
let debugMode = 'prompt';

// clipPath of the most recent result, if any (drives the daemon-gated clip btn)
let lastClipPath = null;

// ---- run history (chrome.storage.local) ------------------------------------
//
// A10: the list is WRITTEN by the service worker the moment a test finishes —
// not here — so a test that ends while this panel is closed still lands in it.
// The panel only reads and renders it (and takes the fresh list the worker
// hands over on the 'history' message).
const HISTORY_KEY = 'qaHistory';

// the active tab we will test (refreshed on activation/update)
let activeTab = null; // { id, url, title, favIconUrl }

// the timeline row that is still "in flight" (latest step while busy)
let pendingStepRow = null;

// A51: last vibe.map.get / vibe.coverage.get results (see onPortMessage's
// 'map'/'coverage' cases) and the host they were last requested for, so a
// same-host tab re-render (favicon/title-only updates) doesn't re-fetch.
let lastMapInfo = null;
let lastCoverageInfo = null;
let siteMapRequestedHost = null;

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
      setBridge(msg);
      break;
    case 'nano':
      setNano(msg.availability);
      break;
    case 'status': {
      const wasBusy = busy;
      setBusy(!!msg.busy);
      // only on the transition — this now arrives every few seconds while a
      // test is running, and one line per poll would bury the real progress
      if (msg.busy && !wasBusy) addProgressLine('(a test is already running — showing live progress)');
      // A10: Chrome can put the extension to sleep mid-test. That was already
      // noticed and then thrown away; now it is said out loud.
      if (!msg.busy && msg.orphanedRun) showInterruptedRun(msg.orphanedRun);
      break;
    }
    case 'accepted':
      setBusy(true);
      hideError();
      addProgressLine('Run accepted. Starting…');
      break;
    case 'progress':
      addProgressLine(msg.line);
      break;
    case 'done':
      // A10: a replayed result must never overwrite a test that is running now.
      if (msg.restored && busy) break;
      finalizePendingStep(true);
      // A7: mid-sequence, this is one flow's verdict — record it and move on to
      // the next rather than ending the whole thing here.
      if (flowQueue && !msg.restored) {
        noteFlowOutcome(msg, msg.verdict, msg.reason || '');
        break;
      }
      setBusy(false);
      renderResult(msg);
      break;
    case 'flows':
      renderFlowChecklist(msg);
      break;
    case 'flows-error':
      onFlowsError(msg.message);
      break;
    case 'check-pages':
      onCheckPages(msg);
      break;
    case 'check-error':
      onCheckError(msg.message);
      break;
    case 'history':
      // A10: the worker writes the "recent tests" list and hands it over.
      renderHistory(Array.isArray(msg.entries) ? msg.entries : []);
      break;
    case 'error':
      finalizePendingStep(false);
      if (decomposing) { onFlowsError(msg.message); break; }
      // A7: a missing key stops the whole sequence; anything else is this one
      // flow's problem, so record it and keep going through the rest.
      if (flowQueue && msg.code !== 'no-key') {
        addProgressLine(msg.message || 'Something went wrong.');
        noteFlowOutcome(null, 'uncertain', msg.message || 'Something went wrong.');
        break;
      }
      if (flowQueue) flowQueue.cancelled = true;
      setBusy(false);
      // A4: "no key yet" is a setup problem, so the banner carries the way to fix it
      if (msg.code === 'no-key') showKeyCta(msg.message);
      else if (isDebuggerBarClosed(msg.message)) showDebugBarClosed();
      else showError(msg.message || 'Something went wrong.');
      break;
    case 'cancelled':
      // The run will also emit done/error; handle both orders gracefully —
      // returning to idle here is safe even if the run already finalized.
      finalizePendingStep(null);
      // A7: stopping means stopping the whole sequence, not just this flow.
      if (flowQueue) flowQueue.cancelled = true;
      setBusy(false);
      addProgressLine(msg.cancelled === false ? 'Nothing to stop.' : 'Stopped.');
      break;
    case 'fix-progress':
      addFixLine(msg.line);
      break;
    case 'fix-confirm':
      onFixNeedsConfirmation(msg);
      break;
    case 'fix-done':
      onFixDone(msg);
      break;
    case 'nano-progress':
      renderNanoProgress(msg.status);
      break;
    case 'artifact':
      onArtifact(msg);
      break;
    case 'artifact-error':
      // The picture is a bonus, never the point — drop it quietly.
      if (msg.path === shotWanted) hideShot();
      break;
    case 'bundle':
      onBundleReceived(msg);
      break;
    case 'bundle-error':
      onBundleError(msg.message);
      break;
    case 'clip':
      onClipReceived(msg);
      break;
    case 'clip-error':
      onClipError(msg.message);
      break;
    case 'map':
      lastMapInfo = msg;
      renderSiteMapCard();
      break;
    case 'coverage':
      lastCoverageInfo = msg;
      renderSiteMapCard();
      break;
    case 'tests':
      // A19: the saved tests recorded for this site.
      onSavedTests(msg);
      break;
    case 'config':
      currentConfig = msg;
      if (typeof msg.debugMode === 'string') debugMode = msg.debugMode;
      renderSettings(msg);
      refreshKeyGate();
      // A26: the one suggestion that needs a login appears once one is saved.
      refreshLoginSuggestion();
      break;
    case 'key-saved':
      onKeySaved(msg);
      break;
    case 'secret-saved':
      onTestLoginSaved(msg);
      break;
    default:
      break;
  }
}

// ---- header state ----------------------------------------------------------
// A20: has a desktop helper EVER connected in this browser profile? Kept in
// local storage, because "no helper yet" and "the helper I installed is down"
// are different situations and only the second one is a problem worth a red
// dot. Read once at startup; set the first time a connection is seen.
const HELPER_SEEN_KEY = 'spikeHelperSeen';
let helperSeen = false;
function loadHelperSeen() {
  try {
    chrome.storage.local.get(HELPER_SEEN_KEY, (res) => {
      void chrome.runtime.lastError;
      if (res && res[HELPER_SEEN_KEY]) {
        helperSeen = true;
        if (bridgeDot) bridgeDot.hidden = false;
        if (liteChip) liteChip.hidden = true;
      }
    });
  } catch { /* a panel with no storage still works, it just forgets */ }
}
function noteHelperSeen() {
  if (helperSeen) return;
  helperSeen = true;
  try { chrome.storage.local.set({ [HELPER_SEEN_KEY]: true }); } catch { /* nicety */ }
}

// A25: "Remember my login for tests" — a per-browser preference (the session
// itself is held by Spike Core on this computer, never here). Offered only
// while the helper is connected, because nothing else can keep it.
const REMEMBER_LOGIN_KEY = 'spikeRememberLogin';
function loadRememberLogin() {
  if (!rememberLogin) return;
  try {
    chrome.storage.local.get(REMEMBER_LOGIN_KEY, (res) => {
      void chrome.runtime.lastError;
      rememberLogin.checked = Boolean(res && res[REMEMBER_LOGIN_KEY]);
    });
  } catch { /* a panel with no storage still works, it just forgets */ }
}
function refreshRememberLogin() {
  if (rememberLoginRow) rememberLoginRow.hidden = !bridgeHealthy();
}
if (rememberLogin) {
  rememberLogin.addEventListener('change', () => {
    try { chrome.storage.local.set({ [REMEMBER_LOGIN_KEY]: rememberLogin.checked }); } catch { /* nicety */ }
  });
}

// A20: Chrome puts up its own "Spike started debugging this browser" bar as
// soon as a test attaches, and closing that bar kills the test. Nothing said
// so. It is explained under the Run button for the first three tests and then
// gets out of the way — after three, the bar is familiar.
const RUN_COUNT_KEY = 'spikeRunCount';
const DEBUG_BAR_NOTE_RUNS = 3;
let runCount = 0;
function refreshDebugBarNote() {
  if (debugBarNote) debugBarNote.hidden = runCount >= DEBUG_BAR_NOTE_RUNS;
}
function loadRunCount() {
  try {
    chrome.storage.local.get(RUN_COUNT_KEY, (res) => {
      void chrome.runtime.lastError;
      const n = res && res[RUN_COUNT_KEY];
      runCount = typeof n === 'number' && n > 0 ? n : 0;
      refreshDebugBarNote();
    });
  } catch {
    refreshDebugBarNote();
  }
}
function noteRunStarted() {
  runCount += 1;
  try { chrome.storage.local.set({ [RUN_COUNT_KEY]: runCount }); } catch { /* nicety */ }
  refreshDebugBarNote();
}

// A4: msg is the full bridge-status payload — { connected, protocolVersion,
// compatible } — not just a boolean, so we can tell "no daemon" apart from
// "daemon connected but too old to trust" and never show a plain green dot
// for the latter.
// A51: whether the last setBridge() call saw a usable (healthy) daemon —
// lets a reconnect re-trigger the "Site map" fetch below, since a request
// made while the daemon was down was answered with present:false and would
// otherwise stay cached under requestSiteMap()'s same-host de-dupe forever.
let wasBridgeHealthyForSiteMap = false;

function setBridge(msg) {
  const connected = !!(msg && msg.connected);
  bridgeConnected = connected;
  bridgeCompatible = connected ? (msg && msg.compatible) : null;
  bridgeProtocolVersion = connected ? (msg && msg.protocolVersion) || null : null;
  const outdated = connected && bridgeCompatible === false;

  // A20: an off/red dot for the majority who never install the desktop helper
  // said "something is broken" about a product that works fine without one.
  // The dot appears only once a helper has actually been seen on this
  // computer; until then the header carries the neutral "Lite" chip.
  if (connected) noteHelperSeen();
  const showDot = connected || helperSeen;
  bridgeDot.hidden = !showDot;
  if (liteChip) liteChip.hidden = showDot;
  bridgeDot.classList.toggle('dot-on', connected && !outdated);
  bridgeDot.classList.toggle('dot-warn', outdated);
  bridgeDot.classList.toggle('dot-off', !connected);
  bridgeDot.title = outdated
    ? 'Spike Core needs an update — open Settings for the command'
    : connected ? 'Spike Core is connected' : "Spike Core isn't running";
  if (bridgeUpdateNote) bridgeUpdateNote.hidden = !outdated;

  // daemon-gated UI: the auto-fix toggle warning + the download-clip button
  refreshAutoFixGate();
  refreshClipVisibility();
  // A18: which model choices are even offered depends on the helper being there
  // to run them, so a connect/disconnect has to re-filter an open Settings screen.
  if (settingsModal && !settingsModal.hidden) refreshSettingsVisibility();

  const healthyNow = bridgeHealthy();
  if (healthyNow && !wasBridgeHealthyForSiteMap) {
    siteMapRequestedHost = null; // force requestSiteMap() to re-fetch below
    requestSiteMap();
  }
  // A19: the saved tests live with the helper — its arrival or departure
  // decides whether that card exists at all.
  requestSavedTests(true);
  // A20: so does the site map card.
  renderSiteMapCard();
  // A25: only the helper can hold a remembered sign-in.
  refreshRememberLogin();
  wasBridgeHealthyForSiteMap = healthyNow;
  // A4: with the desktop helper gone, a command-line model can no longer sign
  // in for itself — whether a key is needed can change with this dot.
  refreshKeyGate();
}

/* A13: what the header says when the on-device model can't run here. It used to
 * promise a "cloud free tier" — there has not been one since the free CLI quota
 * closed, and the browser-only path never had one at all, so the sentence was
 * telling people their tests were free while they were being billed. */
const NO_ONDEVICE_AI_LINE = "On-device AI isn't available on this computer — tests will use your AI key.";

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
      // A13: there is no free rung left to fall back to — the honest line is
      // that the run is paid for with the user's own key until this finishes.
      text = 'On-device AI: downloading — until it\'s ready, tests will use your AI key';
      showOnboard = true;
      showDownloadBtn = false;
      break;
    case 'unavailable':
      text = NO_ONDEVICE_AI_LINE;
      showOnboard = true;
      showGate = true;
      break;
    default:
      text = NO_ONDEVICE_AI_LINE;
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
  nanoLine.textContent = "On-device AI: downloading — until it's ready, tests will use your AI key";
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
// Exactly one of Run / Stop is visible at a time: idle → "Run test", running →
// "Stop test". Run is disabled until a task is typed (and a testable tab is open).
function setBusy(value) {
  // A24: the "Check this site" button follows the same busy state as Run.
  setTimeout(refreshCheckSiteBtn, 0);
  busy = value;
  // running → hide Run, show Stop; idle → the reverse
  runBtn.hidden = value;
  runBtn.textContent = runButtonLabel();
  stopBtn.hidden = !value;
  stopBtn.disabled = false;
  stopBtn.textContent = 'Stop test';
  refreshRunEnabled();
  suggestions.querySelectorAll('.suggestion-card').forEach((c) => {
    c.disabled = value;
  });
  if (!value) finalizePendingStep(null);
  // A19: "Run again"/"Repair" must not be tappable while something is running,
  // and a finished run may have just saved a NEW test for this site.
  renderSavedTests();
  if (!value) requestSavedTests(true);
}

// ---- stop / cancel ---------------------------------------------------------
stopBtn.addEventListener('click', () => {
  if (!busy) return;
  stopBtn.disabled = true;
  stopBtn.textContent = 'Stopping…';
  addProgressLine('Stopping the test…');
  postToSW({ kind: 'cancel' });
});

// keep Run enabled/disabled live as the task text changes
taskInput.addEventListener('input', refreshRunEnabled);

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
  requestSiteMap();
  requestSavedTests(false);
}

// ---- A51: "Site map" card ---------------------------------------------------
/** Asks the SW (which asks the daemon) for the current tab's discovery-layer
 * summary. Re-fetches only when the host actually changes (same de-dupe shape
 * as refreshConsent's consentInitHost) so repeated renderTabCard() calls for
 * the same page (favicon/title-only updates) don't re-request. Read-only —
 * this never triggers a crawl, it only reads what `spike map`/`spike
 * coverage` already wrote to disk. */
function requestSiteMap() {
  const testable = activeTab && isTestableUrl(activeTab.url);
  if (!testable) {
    siteMapRequestedHost = null;
    lastMapInfo = null;
    lastCoverageInfo = null;
    renderSiteMapCard();
    return;
  }
  const host = hostOf(activeTab.url);
  if (host === siteMapRequestedHost) return;
  siteMapRequestedHost = host;
  postToSW({ kind: 'map-get', host });
  postToSW({ kind: 'coverage-get', host });
}

/** Renders the "Site map" card body from the last vibe.map.get / vibe.coverage.get
 * results: a route/state/last-mapped summary plus a per-route covered/uncovered
 * list when both are present, or a hint to run `spike map` when absent. Purely
 * informational — no control here triggers a map/crawl from the panel. */
function renderSiteMapCard() {
  if (!siteMapContent) return;
  // A20: the whole card is built from a file Spike Core writes, and without one
  // it could only ever say "run a command in a terminal" — which is not an
  // instruction to give someone who never opened one. Hide it entirely instead.
  if (siteMapSection) siteMapSection.hidden = !bridgeHealthy();
  siteMapContent.textContent = '';

  if (!lastMapInfo || !lastMapInfo.present) {
    const hint = document.createElement('div');
    hint.className = 'settings-note';
    const icon = document.createElement('span');
    icon.className = 'ico';
    icon.setAttribute('data-icon', 'info');
    hint.appendChild(icon);
    const text = document.createElement('span');
    const target = activeTab && isTestableUrl(activeTab.url) ? new URL(activeTab.url).origin : '<url>';
    text.textContent = `No site map yet for this site. Run "spike map ${target}" (and "spike coverage") in a terminal to build one, then reopen this panel.`;
    hint.appendChild(text);
    siteMapContent.appendChild(hint);
    return;
  }

  const summary = document.createElement('div');
  summary.className = 'settings-group-sub';
  const routeWord = lastMapInfo.routeCount === 1 ? 'route' : 'routes';
  const stateWord = lastMapInfo.stateCount === 1 ? 'state' : 'states';
  const lastMapped = lastMapInfo.lastMappedAt ? new Date(lastMapInfo.lastMappedAt).toLocaleString() : 'unknown';
  summary.textContent = `${lastMapInfo.routeCount} ${routeWord} · ${lastMapInfo.stateCount} ${stateWord} · last mapped ${lastMapped}`;
  siteMapContent.appendChild(summary);

  if (lastCoverageInfo && lastCoverageInfo.present) {
    const cov = lastCoverageInfo.routes;
    if (cov && typeof cov.exercised === 'number' && typeof cov.total === 'number') {
      const covLine = document.createElement('div');
      covLine.className = 'settings-group-sub';
      covLine.textContent = `${cov.exercised}/${cov.total} routes exercised`;
      siteMapContent.appendChild(covLine);
    }
    if (Array.isArray(lastCoverageInfo.perRoute)) {
      const list = document.createElement('div');
      list.className = 'history-list';
      for (const r of lastCoverageInfo.perRoute.slice(0, 25)) {
        const row = document.createElement('div');
        // Reuses .history-item's box styling for a read-only row — not a
        // button, so drop the class's pointer cursor/hover affordance.
        row.className = 'history-item';
        row.style.cursor = 'default';
        const mark = r.exercised ? '✓' : '—'; // check / em-dash
        const elCount = typeof r.elementsTotal === 'number' && r.elementsTotal > 0
          ? ` (${r.elementsTouched}/${r.elementsTotal} elements)`
          : '';
        row.textContent = `${mark} ${r.route}${elCount}`;
        row.title = r.route;
        list.appendChild(row);
      }
      siteMapContent.appendChild(list);
    }
  }
}

if (siteMapToggle && siteMapBody) {
  siteMapToggle.addEventListener('click', () => {
    const open = siteMapToggle.getAttribute('aria-expanded') === 'true';
    siteMapToggle.setAttribute('aria-expanded', String(!open));
    siteMapBody.hidden = open;
  });
}

// ---- A19: "Saved tests" card ------------------------------------------------
//
// A test that passed is saved automatically; running a saved one again costs
// nothing, because no AI is involved — it just repeats the exact clicks and
// typing that worked last time. That is regression testing, and until now the
// panel neither produced nor offered it.
//
// The saved tests are files next to Spike Core (the optional desktop helper),
// so the whole card only exists while the helper is connected.
let savedTests = [];
let savedTestsRequestedHost = null;

function requestSavedTests(force) {
  if (!savedTestsSection) return;
  if (!bridgeHealthy()) {
    savedTestsRequestedHost = null;
    savedTests = [];
    renderSavedTests();
    return;
  }
  const testable = activeTab && isTestableUrl(activeTab.url);
  const host = testable ? hostOf(activeTab.url) : '';
  if (!force && host === savedTestsRequestedHost) return;
  savedTestsRequestedHost = host;
  postToSW({ kind: 'tests-list', host });
}

function onSavedTests(msg) {
  savedTests = Array.isArray(msg && msg.tests) ? msg.tests : [];
  renderSavedTests();
}

function renderSavedTests() {
  if (!savedTestsSection || !savedTestsList) return;
  if (!bridgeHealthy() || savedTests.length === 0) {
    savedTestsSection.hidden = true;
    return;
  }
  savedTestsSection.hidden = false;
  if (savedTestsCount) {
    savedTestsCount.textContent = savedTests.length === 1 ? '1 saved' : `${savedTests.length} saved`;
  }
  savedTestsList.textContent = '';
  for (const t of savedTests) {
    const row = document.createElement('div');
    row.className = 'saved-test';

    const title = document.createElement('div');
    title.className = 'saved-test-task';
    title.textContent = t.task || t.name || '(unnamed test)';
    title.title = t.url || '';
    row.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'saved-test-meta';
    const when = t.createdAt ? new Date(t.createdAt).toLocaleDateString() : '';
    const stepWord = t.steps === 1 ? 'step' : 'steps';
    meta.textContent = `${t.steps || 0} ${stepWord}${when ? ` · saved ${when}` : ''}${t.repairedAt ? ' · repaired' : ''}`;
    row.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'saved-test-actions';

    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'settings-btn-secondary';
    again.textContent = 'Run again (free)';
    again.title = 'Repeat exactly what worked last time. No AI is involved, so this costs nothing.';
    again.disabled = busy;
    again.addEventListener('click', () => startSavedTest(t, false));
    actions.appendChild(again);

    const repair = document.createElement('button');
    repair.type = 'button';
    repair.className = 'connect-alt';
    repair.textContent = 'Repair';
    repair.title = 'The page has changed and the saved test no longer fits? Re-run it and, if it fails, let the AI work out the new steps and save those instead. This one does cost.';
    repair.disabled = busy;
    repair.addEventListener('click', () => startSavedTest(t, true));
    actions.appendChild(repair);

    row.appendChild(actions);
    savedTestsList.appendChild(row);
  }
}

function startSavedTest(test, heal) {
  if (busy || !test || !test.name) return;
  clearFeed();
  hideError();
  resultCard.hidden = true;
  setBusy(true);
  addProgressLine(
    heal
      ? `Running the saved test "${test.task || test.name}" and repairing it if the page has moved on…`
      : `Running the saved test "${test.task || test.name}" again — free, no AI involved.`,
  );
  postToSW({
    kind: 'replay',
    name: test.name,
    heal: Boolean(heal),
    task: test.task || test.name,
    ...(activeTab && typeof activeTab.id === 'number' ? { tabId: activeTab.id } : {}),
  });
}

if (savedTestsToggle && savedTestsList) {
  savedTestsToggle.addEventListener('click', () => {
    const open = savedTestsToggle.getAttribute('aria-expanded') === 'true';
    savedTestsToggle.setAttribute('aria-expanded', String(!open));
    savedTestsList.hidden = open;
  });
}

// ---- interaction consent ---------------------------------------------------
function isLocalHost(host) {
  return host === 'localhost' || host === '127.0.0.1' ||
    host === '[::1]' || /^localhost:/.test(host) || /^127\.0\.0\.1:/.test(host);
}

// (tab, host) pair the consent checkbox was last initialized for. Only when
// this pair changes do we touch consentToggle.checked again — that's how a
// user's explicit opt-out survives repeated renderTabCard() calls (favicon
// load, title change, etc.) triggered by tabs.onUpdated for the same page.
let consentInitTabId = null;
let consentInitHost = null;

/** Default-checked the first time we see a given (tab, host) pair; third-party
 * (non-localhost) hosts keep the box checked but get an amber "interacts as
 * you" note. Once initialized for the current pair, never programmatically
 * change consentToggle.checked again — the user's toggle for that host stands
 * until the tab or host actually changes. */
function refreshConsent() {
  const testable = activeTab && isTestableUrl(activeTab.url);
  if (!testable) {
    consentNote.hidden = true;
    return;
  }
  const host = hostOf(activeTab.url);
  const tabId = activeTab.id;
  if (tabId !== consentInitTabId || host !== consentInitHost) {
    // New (tab, host) pair — (re)default to checked. This does NOT run on a
    // same-page re-render (e.g. favicon/title-only tabs.onUpdated events),
    // so a prior explicit uncheck for this pair is preserved.
    consentInitTabId = tabId;
    consentInitHost = host;
    consentToggle.checked = true;
  }
  // A1 (P0): the checkbox is the look-only switch, so the note has to say which
  // mode the next run will be in — not just flag third-party sites.
  if (!consentToggle.checked) {
    consentNote.hidden = false;
    consentNote.textContent = 'look-only mode: I\u2019ll look at this site and report, but never click or type';
  } else if (isLocalHost(host)) {
    consentNote.hidden = true;
  } else {
    // A36: testing a site you don't own is the NORMAL case, not a hazard, so
    // this says what will happen in plain words and is styled as information
    // rather than a warning.
    consentNote.hidden = false;
    consentNote.textContent = 'I\u2019ll act on this site as you \u2014 signed in as you, with your permissions';
  }
}

// Re-render the note as soon as the user flips the switch (the note tells them
// which mode the next run will be in).
consentToggle.addEventListener('change', refreshConsent);

function refreshRunEnabled() {
  const testable = activeTab && isTestableUrl(activeTab.url);
  const hasTask = (taskInput.value || '').trim().length > 0;
  // Run stays greyed-out until there's both a testable tab AND a task to run.
  runBtn.disabled = busy || decomposing || !testable || !hasTask;
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
/** Show the banner. `action` (optional) appends a clickable link after the
 * message — A4: a banner that says "open Settings" should BE the way there. */
function showError(message, action) {
  keyCtaShown = false;
  errorBanner.textContent = '';
  const text = document.createElement('span');
  text.textContent = message;
  errorBanner.appendChild(text);
  if (action && action.label && typeof action.onClick === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = action.label;
    // styled inline: the banner is the only place this link shape appears
    btn.style.cssText =
      'margin-left:6px;padding:0;border:0;background:none;color:inherit;' +
      'font:inherit;text-decoration:underline;cursor:pointer;';
    btn.addEventListener('click', action.onClick);
    errorBanner.appendChild(btn);
  }
  errorBanner.hidden = false;
}
function hideError() {
  errorBanner.hidden = true;
  keyCtaShown = false;
}

// ---- a test Chrome interrupted (A10) ---------------------------------------
//
// Chrome shuts an idle extension down, and it can do that while a test is
// still going — the feed simply stops and the panel drifts back to idle with
// nothing said. The worker has always noticed this on its next start; until
// now nobody rendered it. Say what happened, in the user's terms, and make
// starting over one tap.

/** The interrupted test we have already told the user about, so the few-second
 * status poll doesn't re-raise the same banner over and over. */
let interruptedRunShown = null;

function showInterruptedRun(run) {
  const id = run && run.runId ? String(run.runId) : 'unknown';
  if (interruptedRunShown === id || busy) return;
  interruptedRunShown = id;
  const task = run && typeof run.task === 'string' ? run.task : '';
  if (task && !(taskInput.value || '').trim()) taskInput.value = task;
  showError('Your last test stopped when Chrome put the extension to sleep — run it again.', {
    label: 'Run again',
    onClick: () => {
      hideError();
      startRun(taskInput.value);
    },
  });
}

// A20: the user closed Chrome's "Spike started debugging this browser" bar (or
// something else detached the debugger) and the test stopped where it stood.
// The raw sentence named Chrome's debugging SESSION — an internal thing nobody
// dismissed. Name the bar they actually clicked, and make starting over one tap.
const DEBUG_BAR_CLOSED_MESSAGE = "The test stopped because Chrome's debugging bar was closed. Run again.";
function isDebuggerBarClosed(message) {
  return /debugging session was closed/i.test(String(message || ''));
}
function showDebugBarClosed() {
  showError(DEBUG_BAR_CLOSED_MESSAGE, {
    label: 'Run again',
    onClick: () => {
      hideError();
      startRun(taskInput.value);
    },
  });
}

/** The banner action that takes the user to the key field. */
const OPEN_SETTINGS_ACTION = {
  label: 'Open Settings',
  onClick: () => openSettings({ focusKey: true }),
};

// ---- first run: no AI key yet (A4) -----------------------------------------
//
// Without a key the panel used to look ready — three suggestion cards that each
// started a run and failed a few seconds later. Now the first tap (and the
// panel's own first render) says what's missing and opens the right field.

/** Is the banner currently showing the "add a key" call-to-action? */
let keyCtaShown = false;

/** True when a model this run needs has no key stored yet. Both roles are
 * checked, because the run refuses on either one. Unknown (settings not
 * fetched yet) is never treated as missing — we don't block on a guess. */
function missingAiKey() {
  if (!currentConfig || !Array.isArray(currentConfig.providers)) return false;
  const roles = [currentConfig.navigator, currentConfig.planner];
  for (const role of roles) {
    if (!role || !role.provider) continue;
    const info = providerInfo(role.provider);
    if (!info || !info.needsKey || info.hasKey) continue;
    // a command-line model signs in by itself, but only when Spike Core
    // (the optional desktop helper) is there to run it
    if (role.mode === 'cli' && bridgeHealthy()) continue;
    return true;
  }
  return false;
}

/** Put the "add a key" call-to-action in the banner. */
function showKeyCta(message) {
  showError(message || 'Add your AI key to start — paste a key from Anthropic, Google or OpenAI and Spike can test this page.', OPEN_SETTINGS_ACTION);
  keyCtaShown = true;
}

/** Show the call-to-action as soon as we know there's no key, and take it back
 * down the moment one is saved. Never disturbs a banner showing something else. */
function refreshKeyGate() {
  if (missingAiKey()) {
    // already up (this runs on every status poll) or a different banner is
    // showing → leave it alone
    if (!busy && !keyCtaShown && errorBanner.hidden) showKeyCta();
  } else if (keyCtaShown) {
    hideError();
  }
}

// ---- result card -----------------------------------------------------------
// ---- A14: the cross-site hop -----------------------------------------------
//
// A run that follows a link off the site it was pointed at (a payment page, a
// sign-in provider, a docs subdomain on another domain) is stopped, on purpose:
// the agent is only trusted to click and type on the site you named. That was
// a dead end — the reason said so and there was nothing to do about it from
// here. Now the result card offers to allow that one extra site and run the
// same test again, and remembers the answer for that pair of sites so the same
// question is never asked twice.

const ALLOWED_PAIRS_KEY = 'spikeAllowedHostPairs';
/** { "<site you're testing>>": { "<extra site>": true } } — loaded once at
 * startup and kept in step with storage on every grant. */
let allowedHostPairs = {};
/** The exact instruction the last run was given, so "run again" repeats THAT
 * and not whatever has since been typed in the box. */
let lastStartedTask = '';

function loadAllowedHostPairs() {
  try {
    chrome.storage.local.get(ALLOWED_PAIRS_KEY, (res) => {
      void chrome.runtime.lastError;
      const v = res && res[ALLOWED_PAIRS_KEY];
      if (v && typeof v === 'object') allowedHostPairs = v;
    });
  } catch { /* no storage — consent just isn't remembered between sessions */ }
}

/** The extra sites the user has already allowed while testing `origin`. */
function allowedExtrasFor(origin) {
  const forOrigin = origin && allowedHostPairs[origin];
  return forOrigin ? Object.keys(forOrigin).filter((h) => forOrigin[h]) : [];
}

function rememberHostPair(origin, extra) {
  if (!origin || !extra) return;
  const forOrigin = allowedHostPairs[origin] || {};
  forOrigin[extra] = true;
  allowedHostPairs[origin] = forOrigin;
  try { chrome.storage.local.set({ [ALLOWED_PAIRS_KEY]: allowedHostPairs }); } catch { /* noop */ }
}

/** The blocked site named in a host-block reason, or ''. */
function blockedHostFrom(reason) {
  const m = /blocked host:\s*([A-Za-z0-9._:-]+)/.exec(String(reason || ''));
  return m ? m[1] : '';
}

/** Offer "Allow <site> and run again" when a host block is what ended the run. */
function renderAllowHostOffer(params, explanation) {
  allowHostBtn.hidden = true;
  if (!explanation || explanation.id !== 'host-blocked') return;
  const host = blockedHostFrom(params && params.reason);
  const origin = activeTab ? hostOf(activeTab.url) : '';
  if (!host || !origin || host === origin) return;
  allowHostBtn.disabled = false;
  allowHostBtn.textContent = `Allow ${host} and run again`;
  allowHostBtn.setAttribute('data-host', host);
  allowHostBtn.hidden = false;
}

allowHostBtn.addEventListener('click', () => {
  if (busy) return;
  const host = allowHostBtn.getAttribute('data-host') || '';
  const origin = activeTab ? hostOf(activeTab.url) : '';
  if (!host || !origin) return;
  rememberHostPair(origin, host);
  allowHostBtn.hidden = true;
  const task = lastStartedTask || (taskInput.value || '').trim();
  if (!task) { showError('Tell me what to test first.'); return; }
  hideError();
  resultCard.hidden = true;
  flowResults.hidden = true;
  resetFixUi();
  clearFeed();
  addProgressLine(`Allowed ${host} for this site. Running the same test again…`);
  setBusy(true);
  postToSW(buildRunMessage(task));
});

// ---- A15: the picture ------------------------------------------------------
//
// Nothing ever showed one. The panel had no reference to a screenshot at all,
// and the fix prompt named one by bare filename — meaningless to someone using
// a web-based coding tool. A picture of the page where it broke is the single
// most useful thing in a bug report, and every run was already taking them.

/** The path we are currently waiting on, so a late answer for a previous run
 * can't paint itself over a newer result. */
let shotWanted = null;

function hideShot() {
  shotWanted = null;
  shotWrap.hidden = true;
  shotImg.removeAttribute('src');
  shotCaption.textContent = '';
}

/** Ask the worker for the one screenshot worth showing for this result. */
function requestShot(params) {
  const wanted = params && typeof params.screenshotPath === 'string' ? params.screenshotPath : '';
  if (!wanted) { hideShot(); return; }
  shotWanted = wanted;
  const failed = String(params.verdict || '').toLowerCase() !== 'pass';
  shotCaption.textContent = failed ? 'The page where it broke' : 'How the page looked at the end';
  shotImg.alt = shotCaption.textContent;
  postToSW({ kind: 'artifact', path: wanted });
}

function onArtifact(msg) {
  if (!msg || msg.path !== shotWanted) return;
  if (!msg.dataBase64) { hideShot(); return; }
  shotImg.src = `data:${msg.mime || 'image/png'};base64,${msg.dataBase64}`;
  shotWrap.hidden = false;
}

/** A14: headline / attribution / next step under the verdict badge. */
const WHOSE_FAULT_TEXT = {
  'your app': 'This looks like a problem in your app.',
  setup: "This isn't a problem in your app — it's a setup problem.",
  'the test': "This isn't a problem in your app — the test couldn't get there.",
};

function renderVerdictWhy(params) {
  const e = params && params.reasonExplained;
  if (!e || !e.headline) {
    verdictWhy.hidden = true;
    return;
  }
  verdictHeadline.textContent = e.headline;
  verdictFault.textContent = WHOSE_FAULT_TEXT[e.whoseFault] || '';
  verdictFault.hidden = !verdictFault.textContent;
  verdictNext.textContent = e.nextStep || '';
  verdictNext.hidden = !verdictNext.textContent;
  verdictWhy.hidden = false;
  renderAllowHostOffer(params, e);
}

/* ---- A29: the plain-English report, as light HTML --------------------------
 * The report arrives as light markdown ("## Everything worked", "**What I
 * did:**", "1. clicked …"). It used to be dropped into a <pre> verbatim, so
 * readers saw the literal "##" and "**" characters. These two helpers turn it
 * into real headings / bold / lists, building DOM nodes (never innerHTML) —
 * every line of it contains text copied off the page under test.
 */

/** Append one line of text to `el`, turning **bold** runs into <strong>. */
function appendInline(el, text) {
  const parts = String(text).split(/\*\*/);
  parts.forEach((part, i) => {
    if (!part) return;
    // odd indexes sat between a pair of ** markers
    if (i % 2 === 1) {
      const b = document.createElement('strong');
      b.textContent = part;
      el.appendChild(b);
    } else {
      el.appendChild(document.createTextNode(part));
    }
  });
}

/**
 * Render the markdown-ish report into `host`, and put the trailing "Cost:"
 * line (engine bookkeeping, not part of the story) into `footer` instead.
 */
function renderPlainReportHtml(text, host, footer) {
  host.textContent = '';
  footer.textContent = '';
  footer.hidden = true;

  const lines = String(text == null ? '' : text).split('\n');
  let list = null; // the <ol>/<ul> currently being filled, if any

  const closeList = () => { list = null; };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (!line.trim()) { closeList(); continue; }

    // the cost line is bookkeeping — it belongs in the muted footer
    if (/^Cost:/i.test(line.trim())) {
      closeList();
      footer.textContent = line.trim();
      footer.hidden = false;
      continue;
    }

    // "## Everything worked" → the report's own heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const h = document.createElement(heading[1].length <= 2 ? 'h3' : 'h4');
      appendInline(h, heading[2]);
      host.appendChild(h);
      continue;
    }

    // "**What I did:**" on its own line → a sub-heading
    const boldOnly = /^\*\*(.+?):?\*\*:?$/.exec(line.trim());
    if (boldOnly) {
      closeList();
      const h = document.createElement('h4');
      h.textContent = `${boldOnly[1]}:`;
      host.appendChild(h);
      continue;
    }

    // "1. clicked Place order" / "- GET /api/order returned 500"
    const numbered = /^(\d+)\.\s+(.*)$/.exec(line.trim());
    const bulleted = /^[-*]\s+(.*)$/.exec(line.trim());
    if (numbered || bulleted) {
      const want = numbered ? 'OL' : 'UL';
      if (!list || list.tagName !== want) {
        list = document.createElement(numbered ? 'ol' : 'ul');
        if (numbered) list.start = Number(numbered[1]) || 1;
        host.appendChild(list);
      }
      const li = document.createElement('li');
      const body = numbered ? numbered[2] : bulleted[1];
      // the step that broke is already marked in words; colour it too
      if (/— this is where it broke$/.test(body)) li.className = 'step-bad';
      appendInline(li, body);
      list.appendChild(li);
      continue;
    }

    closeList();
    const p = document.createElement('p');
    appendInline(p, line.trim());
    host.appendChild(p);
  }
}

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

  // A14: the driver's own reason strings were written for whoever was
  // debugging the driver — several named a setting a panel user has no way to
  // reach, and a rejected AI key read like a bug report about the user's own
  // app. The helper (or the in-browser engine) hands over the translated
  // version; anything the table doesn't know is left to the report below.
  renderVerdictWhy(params);

  // A7: when the run came from a pasted document, the card leads with one row
  // per flow — the single report below is the flow that most needs attention.
  renderFlowOutcome(params.flowOutcome);

  // A24: a whole-site check leads with its own health + coverage sentence,
  // above the per-page rows.
  if (params.checkSummary) {
    const line = document.createElement('div');
    line.className = 'flow-result';
    line.textContent = params.checkSummary;
    flowResults.insertBefore(line, flowResults.firstChild);
    flowResults.hidden = false;
  }

  // A15: the failing step's screenshot (or the final one on a pass), and the
  // one-file bundle for whoever is going to fix it.
  requestShot(params);
  resetBundleBtn();

  const reportText = params.plainReport || params.reason || '(no report)';
  renderPlainReportHtml(reportText, plainReport, plainReportFooter);

  // a saved replay clip (clipPath in the done payload) → offer a download, but
  // ONLY while Spike Core is connected (clips are a daemon-only feature).
  lastClipPath = params.clipPath || null;
  refreshClipVisibility();

  const fix = (params.fixPrompt || '').trim();
  if (fix) {
    fixPrompt.value = fix;
    fixSection.hidden = false;
    resetCopyBtn();
    // auto-fix is only meaningful on a non-pass verdict that produced a fix
    // prompt AND the user opted into auto-fix in Settings (else paste-a-prompt).
    resetFixUi();
    autoFixBtn.hidden = (verdict === 'pass') || debugMode !== 'auto';
    // A11: no coding agent on this computer → no button at all, just the reason.
    if (!autoFixBtn.hidden && fixAgentAvailable() === false) {
      autoFixBtn.hidden = true;
      noFixAgentNote.hidden = false;
      noFixAgentNote.textContent = NO_FIX_AGENT_MESSAGE;
    }
  } else {
    fixSection.hidden = true;
  }

  resultCard.hidden = false;
  resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  if (params.fromHistory) {
    // A19: reopened from "Recent tests" — say so, and don't pretend it just ran.
    addProgressLine(
      `Showing a saved result from ${relativeTime(params.historyTs || Date.now())}. Nothing was run — tap Run test to try it again.`,
    );
    if (!(taskInput.value || '').trim() && typeof params.task === 'string') taskInput.value = params.task;
  } else if (params.restored) {
    // A10: replayed by the worker because this panel wasn't open (or was
    // reopened) when the test finished. Say so, and put the task back in the
    // box so "run it again" is one tap.
    addProgressLine('This is the result of your last test — it finished while this panel was closed.');
    if (!(taskInput.value || '').trim() && typeof params.task === 'string') taskInput.value = params.task;
  } else if (params.durationMs) {
    addProgressLine(`Done in ${(params.durationMs / 1000).toFixed(1)}s.`);
  } else {
    addProgressLine('Done.');
  }

  // spend meter — a compact, honest (estimate-only) cost line from the run's
  // spendSummary { freeCalls, paidCalls, totalTokens, estimatedUsd, capUsd? }.
  const spend = params.spendSummary;
  if (spend && typeof spend === 'object') {
    const usd = typeof spend.estimatedUsd === 'number' ? `~$${spend.estimatedUsd.toFixed(2)}` : '~$0.00';
    const cap = typeof spend.capUsd === 'number' ? ` (cap $${spend.capUsd.toFixed(2)})` : '';
    addProgressLine(
      `Spend: ${usd} est.${cap} — ${spend.freeCalls ?? 0} free · ${spend.paidCalls ?? 0} paid calls, ${spend.totalTokens ?? 0} tokens.`,
    );
  }

  // A10: the "recent tests" row is written by the service worker when the test
  // finishes (so it happens even with this panel closed) and pushed here on the
  // 'history' message — nothing to save from this side.
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
// The clip button only appears when BOTH a clip exists for the last run AND the
// Spike Core is connected (the SW fetches the clip over the daemon bridge).
function refreshClipVisibility() {
  const show = !!lastClipPath && bridgeHealthy() && !fetchingClip;
  clipBtn.hidden = !show;
  if (show) {
    clipBtn.disabled = false;
    clipBtn.innerHTML = qaIcon('download') + '<span>Download clip</span>';
  }
}

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
    saveBlob(base64ToBlob(msg.dataBase64, msg.mime), msg.name || 'replay.webm');
  } catch (e) {
    onClipError(String(e && e.message ? e.message : e));
  }
}

// ---- A15: "Send to my developer" -------------------------------------------
//
// Everything the test produced — the report, every screenshot, the replay clip
// when there is one — as ONE file. Six separate downloads is not something you
// can hand to somebody.

let fetchingBundle = false;

function resetBundleBtn() {
  fetchingBundle = false;
  bundleBtn.disabled = false;
  bundleBtn.innerHTML = qaIcon('download') + '<span>Send to my developer</span>';
}

bundleBtn.addEventListener('click', () => {
  if (fetchingBundle) return;
  fetchingBundle = true;
  bundleBtn.disabled = true;
  bundleBtn.textContent = 'Packing…';
  postToSW({ kind: 'bundle' });
});

function onBundleReceived(msg) {
  resetBundleBtn();
  if (!msg || !msg.dataBase64) { onBundleError('nothing came back'); return; }
  try {
    saveBlob(base64ToBlob(msg.dataBase64, msg.mime || 'application/zip'), msg.name || 'spike-test.zip');
  } catch (e) {
    onBundleError(String(e && e.message ? e.message : e));
  }
}

function onBundleError(message) {
  resetBundleBtn();
  showError('Could not pack that up: ' + (message || 'unknown error'));
}

/** Hand a blob to the browser as a download. */
function saveBlob(blob, filename) {
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // revoke after the click has had a chance to start the download
  setTimeout(() => { try { URL.revokeObjectURL(objUrl); } catch { /* noop */ } }, 4000);
}

function onClipError(message) {
  fetchingClip = false;
  clipBtn.disabled = false;
  clipBtn.innerHTML = qaIcon('download') + '<span>Download clip</span>';
  showError('Could not download the clip: ' + (message || 'unknown error'));
}

// ---- auto-fix --------------------------------------------------------------
/* A11: auto-fix only exists if a coding agent is installed on this computer.
 * Spike Core tells us whether it found one; when it says no we hide the button
 * and the toggle outright rather than offering something that can only fail. */
const NO_FIX_AGENT_MESSAGE =
  'Auto-fix needs a coding agent installed on this computer (Claude Code, Codex or Gemini CLI). ' +
  'You can still copy the fix prompt.';

/** Tri-state: true / false / null when Spike Core hasn't told us (no helper
 * connected, or an older one) — in which case nothing changes. */
function fixAgentAvailable() {
  if (!currentConfig || typeof currentConfig.fixAgentAvailable !== 'boolean') return null;
  return currentConfig.fixAgentAvailable;
}
function resetFixUi() {
  fixing = false;
  noFixAgentNote.hidden = true;
  noFixAgentNote.textContent = '';
  autoFixBtn.hidden = false;
  autoFixBtn.disabled = false;
  autoFixBtn.innerHTML = qaIcon('sparkles') + '<span>Auto-fix with my coding agent</span>';
  fixStatus.hidden = true;
  fixStatus.textContent = '';
  fixNote.hidden = true;
  fixNote.textContent = '';
}

/** Put the UI into "a fix is running" state and ask for the fix. `confirmed` is
 * set only on the second attempt, after the user accepted the A11 dialog. */
function startFix(confirmed) {
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
  postToSW(confirmed ? { kind: 'fix', confirmed: true } : { kind: 'fix' });
}

/** Roll the UI back out of the "fixing" state without treating it as a failure
 * (the confirm dialog and a cancelled confirm both land here). */
function stopFixUi() {
  fixing = false;
  autoFixBtn.disabled = false;
  autoFixBtn.innerHTML = qaIcon('sparkles') + '<span>Auto-fix with my coding agent</span>';
  fixStatus.hidden = true;
  fixStatus.textContent = '';
  suggestions.querySelectorAll('.suggestion-card').forEach((c) => { c.disabled = false; });
  refreshRunEnabled();
}

/* A11: Spike Core answered "I need the user to say yes first" instead of
 * starting. It has no terminal to ask in, so the question is asked here, once
 * per project folder — accepting is remembered on this computer. */
function onFixNeedsConfirmation(msg) {
  stopFixUi();
  const folder = (msg && msg.projectDir) ? String(msg.projectDir) : 'your project folder';
  confirmModalBody.textContent =
    'Spike will let your coding agent edit files in ' + folder + '. Continue?';
  confirmModal.hidden = false;
  confirmOk.focus();
}

function closeConfirmModal() {
  confirmModal.hidden = true;
  confirmModalBody.textContent = '';
}

confirmCancel.addEventListener('click', () => {
  closeConfirmModal();
  addFixLine('Auto-fix cancelled — nothing was changed.');
});

confirmOk.addEventListener('click', () => {
  closeConfirmModal();
  startFix(true);
});

autoFixBtn.addEventListener('click', () => {
  if (fixing) return;
  if (!bridgeHealthy()) {
    showError(bridgeConnected && bridgeCompatible === false
      ? "Spike Core is outdated and can't run auto-fix reliably. Update it (Settings → re-run the installer), then try again."
      : 'Auto-fix needs Spike Core running. Start it, then try again — or use the fix prompt below.');
    return;
  }
  startFix(false);
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

/** The debug mode currently chosen in the form (the auto-fix toggle). */
function selectedDebugMode() {
  return setAutoFix.checked ? 'auto' : 'prompt';
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

/** A18: without Spike Core (the optional desktop helper) the browser-only path
 * can't drive a locally-installed command-line tool or a local model server, so
 * offering those choices only sells a run that limps to "not sure". Hide the
 * ones it can't run — `liteUsable` on each provider says which. On-device AI is
 * the exception: it is flagged unusable only as the model that PLANS, and the
 * Navigator card is exactly where it belongs. */
function offerOnlyRunnableChoices(refs) {
  const helper = bridgeHealthy();
  let movedOff = false;
  refs.provider.querySelectorAll('option').forEach((opt) => {
    const info = providerInfo(opt.value);
    const runnable = helper || opt.value === 'nano' || !info || info.liteUsable !== false;
    opt.hidden = !runnable;
    opt.disabled = !runnable;
    if (!runnable && refs.provider.value === opt.value) movedOff = true;
  });
  // a saved pin we just hid would otherwise stay selected but invisible
  if (movedOff) {
    const first = Array.from(refs.provider.options).find((o) => !o.disabled);
    if (first) refs.provider.value = first.value;
  }
  return helper;
}

/** Show/hide the mode radios, key row, model placeholder and (nav-only) nano
 * note/download for ONE card, per its current selection. */
function refreshCardVisibility(refs) {
  const helper = offerOnlyRunnableChoices(refs);
  const provider = refs.provider.value;
  const info = providerInfo(provider);
  const modes = (info && Array.isArray(info.modes)) ? info.modes : [];

  // mode radios: hide entirely for single-mode providers (nano, ollama, openrouter)
  const hasApi = modes.includes('api');
  // A18: a command-line tool needs Spike Core to run it; without one, don't
  // offer the choice at all (it fails only once a run is already going).
  const hasCli = modes.includes('cli') && helper;
  const showModes = hasApi && hasCli;
  refs.modeRow.hidden = !showModes;
  refs.modeRow.querySelectorAll(`input[name="${refs.modeName}"]`).forEach((el) => {
    if (el.value === 'api') el.disabled = !hasApi;
    if (el.value === 'cli') el.disabled = !hasCli;
    // a saved "command-line tool" pin with no Spike Core to run it would stay
    // silently checked behind a hidden row and hide the key box with it
    if (el.value === 'cli' && !hasCli && el.checked) el.checked = false;
    if (el.value === 'api' && hasApi && !hasCli) el.checked = true;
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
  // A32: "Remove key" only exists once there is a stored key to remove.
  setKeyRemoveVisible(refs, showKey && !!(info && info.hasKey));

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

/** Show/hide the Brain card's own provider/mode/model/key fields vs. the "same
 * as Navigator" summary note, and keep that note's text current. The key is
 * ALREADY shared across cards when both pick the same provider (the vault
 * stores it by provider, not by role — see onKeySaved) — this toggle just
 * saves the user from picking the same provider/mode/model twice.
 *
 * Nano (on-device) is navigator-only — it never plans goals (see CLAUDE.md) —
 * so the shortcut is disabled while the Navigator is set to Nano, since
 * copying it onto the Brain card would silently do nothing useful. */
function refreshSameAsNav() {
  const navIsNano = selectedNavProvider() === 'nano';
  setSameAsNav.disabled = navIsNano;
  if (navIsNano) setSameAsNav.checked = false;

  const same = setSameAsNav.checked;
  setBrainFields.hidden = same;
  setSameAsNavNote.hidden = !same;
  if (same) {
    const info = providerInfo(selectedNavProvider());
    const providerLabel = (info && info.id) || selectedNavProvider();
    // A18: a BLANK model box does NOT mean "the Navigator's model" — the engine
    // resolves an empty model per ROLE, so the brain lands on the smart default
    // (Sonnet), not on the navigator's cheap one. Say what will actually run.
    const modelLabel = selectedNavModel() || defaultModelFor(info, selectedNavMode(), 'brain');
    setSameAsNavNoteText.textContent =
      `Brain will use the Navigator's setup: ${providerLabel} (${selectedNavMode()}, ${modelLabel}).`;
  }
}

/** Refresh BOTH settings cards + the debug agent row. Called on open and whenever
 * provider/mode/debug-mode change. */
function refreshSettingsVisibility() {
  refreshCardVisibility(navCardRefs);
  refreshCardVisibility(brainCardRefs);
  refreshSameAsNav();
  refreshAutoFixGate();
  // agent select only when auto-fix is on
  setDebugAgentRow.hidden = selectedDebugMode() !== 'auto';
  // A11: the project folder only means anything while Spike Core (optional
  // desktop helper) is connected — it is the only thing that edits files.
  if (setProjectFolderRow) setProjectFolderRow.hidden = !bridgeHealthy();
  refreshAccordionSummaries();
}

/** Auto-fix needs a healthy Spike Core (daemon connected AND protocol-
 * compatible — see bridgeHealthy()). When it isn't, force the toggle off,
 * show a note explaining why, and reveal the one-liner connect block — its
 * copy switches between "connect" (no daemon) and "update" (daemon present
 * but too old) so the instruction always matches reality. The toggle is
 * otherwise free. */
function refreshAutoFixGate() {
  if (!setAutoFix) return;
  const wantAuto = setAutoFix.checked;
  const healthy = bridgeHealthy();
  const outdated = bridgeConnected && bridgeCompatible === false;
  // A11: Spike Core is connected and found no coding agent → auto-fix is not an
  // option at all. Hide the toggle (forcing paste-a-prompt) and say why.
  if (healthy && fixAgentAvailable() === false) {
    setAutoFix.checked = false;
    if (setAutoFixRow) setAutoFixRow.hidden = true;
    setAutoFixNote.hidden = false;
    setAutoFixNoteText.textContent = NO_FIX_AGENT_MESSAGE;
    setDebugAgentRow.hidden = true;
    if (setProjectFolderRow) setProjectFolderRow.hidden = true;
    if (connectApp) connectApp.hidden = true;
    return;
  }
  if (setAutoFixRow) setAutoFixRow.hidden = false;
  if (wantAuto && !healthy) {
    // the user turned it on without a healthy daemon — bounce it back off + explain
    setAutoFix.checked = false;
    setAutoFixNote.hidden = false;
    setAutoFixNoteText.textContent = outdated
      ? 'Auto-fix needs an up-to-date Spike Core — yours is outdated. Update it below, then turn this on.'
      : 'Auto-fix needs Spike Core running — it hands the fix to your coding agent. Set it up below, then turn this on.';
    setDebugAgentRow.hidden = true;
  } else {
    setAutoFixNote.hidden = !(wantAuto && !healthy);
  }
  // show the connect block whenever the daemon isn't healthy (auto-fix is the
  // only daemon-gated setting in this accordion, so it's the natural home for it)
  if (connectApp) {
    connectApp.hidden = healthy;
    if (!healthy) {
      // A3: don't show the install command until we've confirmed it's
      // actually reachable — kick off the (cached, once-per-session) probe
      // if it hasn't run yet, and re-render when it resolves.
      if (installReachable === null) probeInstallReachable();
      if (installReachable === true) {
        const copy = outdated ? CONNECT_APP_COPY.update : CONNECT_APP_COPY.install;
        if (connectAppTitle) connectAppTitle.textContent = copy.title;
        if (connectAppSub) connectAppSub.textContent = copy.sub;
        if (connectAppInstallUi) connectAppInstallUi.hidden = false;
        renderConnectCmd();
      } else {
        // unreachable (or still probing) — show a plain heads-up instead of
        // a command that would 404.
        if (connectAppTitle) connectAppTitle.textContent = 'Spike Core (optional desktop helper)';
        if (connectAppSub) connectAppSub.textContent = "Spike Core isn't available to install yet — check back soon.";
        if (connectAppInstallUi) connectAppInstallUi.hidden = true;
      }
    }
  }
}

/** Reflect the selected OS + command style into the command box + pills. */
function renderConnectCmd() {
  if (!connectCmd) return;
  const cmds = connectCmds();
  connectCmd.textContent = cmds[connectOs] || cmds.win;
  if (connectApp) {
    connectApp.querySelectorAll('.connect-os-btn').forEach((b) => {
      b.classList.toggle('is-active', b.getAttribute('data-os') === connectOs);
    });
  }
  if (connectNpmToggle) {
    connectNpmToggle.textContent = connectUseNpm
      ? 'use the one-line script instead'
      : 'or install without a remote script (npm)';
  }
}

/** Short right-aligned summary chips on each collapsed accordion head. */
function refreshAccordionSummaries() {
  const navSum = $('accNavSummary');
  const brainSum = $('accBrainSummary');
  const debugSum = $('accDebugSummary');
  if (navSum) {
    const info = providerInfo(selectedNavProvider());
    const label = (info && info.id) || selectedNavProvider();
    const pinned = selectedNavModel() || defaultModelFor(info, selectedNavMode(), 'navigator') || label;
    // A13: a pin that can't run here (no key, a command-line tool that isn't
    // installed, on-device AI on a machine that can't host it) is skipped and
    // something else — often a model you pay for — drives instead. Say which,
    // rather than showing a choice that isn't in effect.
    const resolved = currentConfig && currentConfig.resolvedNavigatorName;
    const differs =
      resolved &&
      String(resolved).toLowerCase() !== String(selectedNavProvider()).toLowerCase() &&
      String(resolved).toLowerCase() !== String(pinned).toLowerCase();
    navSum.textContent = differs ? `${pinned} · actually using: ${resolved}` : pinned;
  }
  if (brainSum) {
    if (setSameAsNav.checked) { brainSum.textContent = 'same as Navigator'; }
    else {
      const info = providerInfo(selectedProvider());
      const label = (info && info.id) || selectedProvider();
      brainSum.textContent = setModel.value.trim() || defaultModelFor(info, selectedMode(), 'brain') || label;
    }
  }
  if (debugSum) debugSum.textContent = selectedDebugMode() === 'auto' ? 'auto-fix on' : 'paste a prompt';
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

  // "same as Navigator": auto-detected from the saved config (Brain's provider/
  // mode/model exactly match the Navigator's) rather than a separate stored
  // flag — the user can still flip it either way.
  setSameAsNav.checked = Boolean(
    planner.provider && planner.provider === navi.provider &&
    (planner.mode || 'api') === (navi.mode || 'ondevice') &&
    (planner.model || '') === (navi.model || ''),
  );

  // debug mode → auto-fix toggle
  setAutoFix.checked = (cfg.debugMode || 'prompt') === 'auto';

  // opt-in video assertions (paid, slower)
  if (setVideoAssert) setVideoAssert.checked = Boolean(cfg.videoAssertions);

  // safety: spend cap blank = no cap. (Look-only mode has no Settings control —
  // the per-site "Allow the agent to click & type" checkbox above the Run button
  // is the switch; the stored key survives for command-line/config parity only.)
  if (setSpendCap) setSpendCap.value = typeof cfg.spendCapUsd === 'number' ? String(cfg.spendCapUsd) : '';

  // A1: deterministic verdicts default ON when unset
  if (setStrictOracles) setStrictOracles.checked = cfg.strictOracles !== false;

  // A5: an optional saved test login — presence only, never a stored value.
  renderTestLogin(cfg);

  // debug agent
  if (cfg.debugAgent) setDebugAgent.value = cfg.debugAgent;

  // A11: the project folder auto-fix edits (blank = not chosen yet).
  if (setProjectFolder) setProjectFolder.value = cfg.fixAgentCwd || '';

  refreshSettingsVisibility();

  // A4: a first-run user sent here by the "add a key" prompt lands on the field
  if (focusKeyOnRender) {
    focusKeyOnRender = false;
    focusKeyEntry();
  }
}

// ---- test login (A5) -------------------------------------------------------
//
// A saved test login is the alternative to typing a password into the task box,
// which used to land verbatim in saved results, saved tests and prompts people
// copy elsewhere. Nothing here ever holds the value: the panel sends it once to
// be stored on this machine, and from then on a run only ever refers to it by
// name. The value is filled in at the instant it is typed into the page.

const TEST_USER_REF = '{{secret:TEST_USER}}';
const TEST_PASSWORD_REF = '{{secret:TEST_PASSWORD}}';

/** Both halves of a test login saved? */
function hasSavedLogin() {
  const saved = currentConfig && currentConfig.testLogin;
  return Boolean(saved && saved.user && saved.password);
}

/** A26: the "Log in and check the dashboard loads" suggestion exists only when
 * a test login has been saved — otherwise it is a card that cannot succeed,
 * which is exactly what the first suggestion used to be. */
function refreshLoginSuggestion() {
  if (!suggestLoginCard) return;
  suggestLoginCard.hidden = !hasSavedLogin();
}

/** Tell the agent it has a login to use, by reference — never by value. Left
 * alone when nothing is saved, when the task is empty, or when the task already
 * refers to the saved login. */
function withSavedLogin(task) {
  if (!task || !hasSavedLogin()) return task;
  if (task.includes(TEST_USER_REF) || task.includes(TEST_PASSWORD_REF)) return task;
  return `${task}\n\nUse ${TEST_USER_REF} / ${TEST_PASSWORD_REF} to log in.`;
}

/** Reflect what is saved, without ever showing a stored value. */
function renderTestLogin(cfg) {
  if (!setTestLoginStatus) return;
  const saved = (cfg && cfg.testLogin) || {};
  const both = Boolean(saved.user && saved.password);
  setTestLoginStatus.classList.remove('err');
  setTestLoginStatus.textContent = both
    ? 'Saved on this computer — runs will use it to log in.'
    : saved.user || saved.password
      ? 'Half saved — fill in both fields and save again.'
      : '';
  if (setTestLoginClear) setTestLoginClear.hidden = !(saved.user || saved.password);
  const summary = ACCORDIONS[2] && ACCORDIONS[2].summary;
  if (summary) summary.textContent = both ? 'saved' : 'not set';
}

function saveTestLogin() {
  if (!setTestUser || !setTestPassword) return;
  const user = setTestUser.value.trim();
  const password = setTestPassword.value;
  if (!user || !password) {
    setTestLoginStatus.classList.add('err');
    setTestLoginStatus.textContent = 'Fill in both fields first.';
    return;
  }
  setTestLoginStatus.classList.remove('err');
  setTestLoginStatus.textContent = 'saving…';
  postToSW({ kind: 'set-secret', name: 'TEST_USER', value: user });
  postToSW({ kind: 'set-secret', name: 'TEST_PASSWORD', value: password });
  // the value is on its way to storage; stop holding it in the form
  setTestPassword.value = '';
}

function clearTestLogin() {
  setTestLoginStatus.classList.remove('err');
  setTestLoginStatus.textContent = 'forgetting…';
  setTestUser.value = '';
  setTestPassword.value = '';
  postToSW({ kind: 'clear-secret', name: 'TEST_USER' });
  postToSW({ kind: 'clear-secret', name: 'TEST_PASSWORD' });
}

/** Reply to a set/clear. Re-reads the settings so the saved state comes from
 * storage rather than from what the form happened to hold. */
function onTestLoginSaved(msg) {
  if (!setTestLoginStatus) return;
  if (msg && msg.ok === false) {
    setTestLoginStatus.classList.add('err');
    setTestLoginStatus.textContent = msg.message ? ('could not save: ' + msg.message) : 'could not save the test login';
    return;
  }
  postToSW({ kind: 'config-get' });
}

if (setTestLoginSave) setTestLoginSave.addEventListener('click', saveTestLogin);
if (setTestLoginClear) setTestLoginClear.addEventListener('click', clearTestLogin);

// ---- saving the key (A4) ---------------------------------------------------
//
// One code path stores a key, whoever asks for it: the little "Save key" button
// next to the field, leaving the field (blur), and the modal's primary Save.
// Before A4 only the little button did, so a pasted key was silently dropped
// when the user hit the big Save — the single most common first-run dead end.

/** Providers whose key save was started by the primary Save button; the modal
 * stays open until each one answers. */
const pendingPrimarySaves = new Set();
let primarySaveFailed = false;
/** The settings payload held back until those key saves answer, so the stored
 * key is on disk before anything re-reads it. */
let pendingConfigSet = null;
let primarySaveTimer = null;

/** Store the key typed into ONE card. No-ops when that card needs no key right
 * now, when the field is empty, or when this exact key is already stored.
 * Returns the provider whose save is in flight (so a caller can wait for it),
 * or null when there is nothing to wait for. */
function saveKeyFromCard(refs) {
  if (!refs || !refs.key || !refs.keyRow || refs.keyRow.hidden) return null;
  const key = refs.key.value.trim();
  if (!key) return null;
  const provider = refs.provider.value;
  const stamp = provider + '\n' + key;
  if (refs.savedStamp === stamp) return refs.saving ? provider : null;
  refs.savedStamp = stamp;
  refs.saving = true;
  refs.keyStatus.classList.remove('err');
  refs.keyStatus.textContent = 'saving…';
  postToSW({ kind: 'set-key', provider, key });
  return provider;
}

/** Same, but always re-sends (what the explicit "Save key" button should do). */
function forceSaveKeyFromCard(refs) {
  if (!refs) return null;
  refs.savedStamp = null;
  return saveKeyFromCard(refs);
}

/** Every key save the primary Save started has answered → send the settings and
 * (on success) close the modal, leaving the "saved ✓" visible for a beat. */
function settlePrimarySave() {
  if (pendingPrimarySaves.size > 0) return;
  if (primarySaveTimer) { clearTimeout(primarySaveTimer); primarySaveTimer = null; }
  if (pendingConfigSet) {
    postToSW(pendingConfigSet);
    pendingConfigSet = null;
  }
  if (!primarySaveFailed) setTimeout(closeSettings, 500);
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
    refs.saving = false;
    if (msg.ok) {
      refs.keyStatus.classList.remove('err');
      refs.keyStatus.textContent = msg.cleared ? 'key removed' : 'saved ✓';
      // keep the key in the field (persistent) — the user can reveal it with the
      // eye toggle to confirm; clear it only when the key was removed.
      if (msg.cleared) { refs.key.value = ''; refs.savedStamp = null; }
      // A32: there is nothing left to remove once it is gone.
      setKeyRemoveVisible(refs, !msg.cleared && !refs.keyRow.hidden);
    } else {
      // let the next attempt through instead of treating it as already stored
      refs.savedStamp = null;
      refs.keyStatus.classList.add('err');
      refs.keyStatus.textContent = msg.message ? ('error: ' + msg.message) : 'could not save key';
    }
  }
  if (pendingPrimarySaves.delete(msg.provider)) {
    if (!msg.ok) primarySaveFailed = true;
    settlePrimarySave();
  }
  // a key that just landed clears the "add a key" prompt on the main screen
  refreshKeyGate();
}

/* ---- A32: forgetting a stored key ------------------------------------------
 * Saving a key had a button and removing one had nothing — the only way out
 * was to overwrite it with a different key, or go to the command line. The
 * link appears under a card only once that provider actually has a stored key,
 * and asks once before it goes: the key may be the only copy the user has.
 */

/** Show or hide one card's "Remove key" link, always in its resting state. */
function setKeyRemoveVisible(refs, show) {
  if (!refs || !refs.keyRemove) return;
  refs.keyRemove.hidden = !show;
  if (!show) resetKeyRemove(refs.keyRemove);
}

function resetKeyRemove(btn) {
  if (!btn) return;
  if (btn._confirmTimer) { clearTimeout(btn._confirmTimer); btn._confirmTimer = null; }
  btn.classList.remove('confirming');
  btn.textContent = 'Remove key';
}

/** First click asks, second click (within 6s) removes. */
function wireKeyRemove(refs) {
  if (!refs || !refs.keyRemove) return;
  refs.keyRemove.addEventListener('click', () => {
    const btn = refs.keyRemove;
    if (!btn.classList.contains('confirming')) {
      btn.classList.add('confirming');
      btn.textContent = 'Remove it?';
      btn._confirmTimer = setTimeout(() => resetKeyRemove(btn), 6000);
      return;
    }
    resetKeyRemove(btn);
    const provider = refs.provider.value;
    refs.savedStamp = null;
    refs.saving = true;
    refs.keyStatus.classList.remove('err');
    refs.keyStatus.textContent = 'removing…';
    postToSW({ kind: 'clear-key', provider });
  });
}
wireKeyRemove(brainCardRefs);
wireKeyRemove(navCardRefs);

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
wireKeyToggle(setTestPasswordToggle, setTestPassword);

/** A4: `{ focusKey: true }` opens straight onto the key field of the model that
 * clicks — the one thing a first-run user has to fill in. The focus waits for
 * the settings render when they haven't been fetched yet. */
let focusKeyOnRender = false;
function openSettings(opts) {
  settingsModal.hidden = false;
  const wantKey = Boolean(opts && opts.focusKey === true);
  focusKeyOnRender = wantKey;
  postToSW({ kind: 'config-get' });
  if (wantKey && currentConfig) {
    focusKeyOnRender = false;
    focusKeyEntry();
  }
}

/** Expand the "model that clicks" section and put the cursor in its key field. */
function focusKeyEntry() {
  for (const acc of ACCORDIONS) {
    if (!acc.head || !acc.body) continue;
    const open = acc === ACCORDIONS[0];   // the model that clicks
    acc.head.setAttribute('aria-expanded', String(open));
    acc.body.hidden = !open;
  }
  const field = navCardRefs.keyRow && !navCardRefs.keyRow.hidden ? navCardRefs.key : navCardRefs.provider;
  if (!field) return;
  try { field.focus(); } catch { /* not focusable — the section is open either way */ }
  if (typeof field.scrollIntoView === 'function') field.scrollIntoView({ block: 'nearest' });
}

function closeSettings() {
  settingsModal.hidden = true;
}

settingsBtn.addEventListener('click', openSettings);
// header outdated-daemon banner (A4): tap it straight into Settings, where
// the "Update Spike Core" one-liner lives (see refreshAutoFixGate).
if (bridgeUpdateNote) {
  bridgeUpdateNote.addEventListener('click', openSettings);
  bridgeUpdateNote.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openSettings(); }
  });
}
// click the dimmed backdrop (outside the card) to dismiss
settingsModal.addEventListener('click', (ev) => {
  if (ev.target === settingsModal) closeSettings();
});

// accordions: expand one section at a time (clicking an open head collapses it)
for (const acc of ACCORDIONS) {
  if (!acc.head || !acc.body) continue;
  acc.head.addEventListener('click', () => {
    const open = acc.head.getAttribute('aria-expanded') === 'true';
    for (const other of ACCORDIONS) {
      if (!other.head || !other.body) continue;
      const willOpen = other === acc ? !open : false;
      other.head.setAttribute('aria-expanded', String(willOpen));
      other.body.hidden = !willOpen;
    }
  });
}
// settings-side "Download on-device AI" (navigator card) — reuses the SW nano-download flow
if (setNavNanoDownload) {
  setNavNanoDownload.addEventListener('click', () => {
    nanoDownloading = true;      // keep it hidden across re-renders until ready
    setNavNanoDownload.hidden = true;
    postToSW({ kind: 'nano-download' });
  });
}

// A18: the spend cap lives on the main screen now, not inside the Settings
// screen's Save, so it has to persist itself. `config-set` is merged field by
// field on both paths (desktop helper and browser-only), so sending the one
// field is safe.
if (setSpendCap) {
  setSpendCap.addEventListener('change', () => {
    const raw = setSpendCap.value.trim();
    const n = Number(raw);
    postToSW({ kind: 'config-set', spendCapUsd: raw !== '' && n > 0 ? n : 0 });
  });
}

// auto-fix toggle: gate on the daemon, then refresh the agent row + summary
setAutoFix.addEventListener('change', refreshSettingsVisibility);
setModel.addEventListener('input', refreshAccordionSummaries);
setSameAsNav.addEventListener('change', refreshSettingsVisibility);

// connect-spike-core block: OS switcher + copy the one-liner
if (connectApp) {
  connectApp.querySelectorAll('.connect-os-btn').forEach((b) => {
    b.addEventListener('click', () => {
      connectOs = b.getAttribute('data-os') || 'win';
      renderConnectCmd();
    });
  });
}
if (connectNpmToggle) {
  connectNpmToggle.addEventListener('click', () => {
    connectUseNpm = !connectUseNpm;
    renderConnectCmd();
  });
}
if (connectCopy) {
  let connectCopyTimer = null;
  connectCopy.addEventListener('click', async () => {
    const cmds = connectCmds();
    const text = cmds[connectOs] || cmds.win;
    try { await navigator.clipboard.writeText(text); }
    catch { /* clipboard may be unavailable; the code box is still selectable */ }
    connectCopy.classList.add('copied');
    connectCopy.textContent = 'Copied';
    if (connectCopyTimer) clearTimeout(connectCopyTimer);
    connectCopyTimer = setTimeout(() => {
      connectCopy.classList.remove('copied');
      connectCopy.textContent = 'Copy';
    }, 2000);
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
// live-update the "same as Navigator" summary + accordion chip as the Navigator's
// model text changes
setNavModel.addEventListener('input', () => { refreshSameAsNav(); refreshAccordionSummaries(); });

// Save key — one handler per card; keys are stored per-provider (shared across cards).
setKeySave.addEventListener('click', () => { forceSaveKeyFromCard(brainCardRefs); });
setNavKeySave.addEventListener('click', () => { forceSaveKeyFromCard(navCardRefs); });

// A4: leaving the field saves it too, so a pasted key can't be lost by tabbing
// away, closing the modal, or hitting the primary Save.
setKey.addEventListener('blur', () => { saveKeyFromCard(brainCardRefs); });
setNavKey.addEventListener('blur', () => { saveKeyFromCard(navCardRefs); });

settingsSave.addEventListener('click', () => {
  // A4: the primary Save owns the key fields too. Any key typed but not yet
  // stored goes first, and the settings themselves wait for it — otherwise the
  // fresh settings are read back before the key exists and the row reports
  // "no key" for a key the user just pasted.
  pendingPrimarySaves.clear();
  primarySaveFailed = false;
  const navSaving = saveKeyFromCard(navCardRefs);
  if (navSaving) pendingPrimarySaves.add(navSaving);
  if (!setSameAsNav.checked) {
    const brainSaving = saveKeyFromCard(brainCardRefs);
    if (brainSaving) pendingPrimarySaves.add(brainSaving);
  }

  // "same as Navigator": ship the Brain an EXACT copy of the Navigator's
  // provider/mode/model. Since the vault stores API keys per-provider (not
  // per-role), matching provider is all it takes to also share the key.
  const planner = setSameAsNav.checked
    ? { provider: selectedNavProvider(), mode: selectedNavMode(), model: selectedNavModel() }
    : { provider: selectedProvider(), mode: selectedMode(), model: setModel.value.trim() };
  const configSet = {
    kind: 'config-set',
    planner,
    navigator: {
      provider: selectedNavProvider(),
      mode: selectedNavMode(),
      model: selectedNavModel(),
    },
    debugMode: selectedDebugMode(),
    debugAgent: setDebugAgent.value,
    fixAgentCwd: setProjectFolder ? setProjectFolder.value.trim() : '',
    videoAssertions: Boolean(setVideoAssert && setVideoAssert.checked),
    spendCapUsd:
      setSpendCap && setSpendCap.value.trim() !== '' && Number(setSpendCap.value) > 0
        ? Number(setSpendCap.value)
        : undefined,
    strictOracles: Boolean(setStrictOracles && setStrictOracles.checked),
  };

  if (pendingPrimarySaves.size === 0) {
    postToSW(configSet);
    closeSettings();
    return;
  }
  // hold the settings until every key save answers (settlePrimarySave sends
  // them). A silent SW never strands the settings: flush after 4s and leave the
  // modal open so the unfinished key row is visible.
  pendingConfigSet = configSet;
  if (primarySaveTimer) clearTimeout(primarySaveTimer);
  primarySaveTimer = setTimeout(() => {
    primarySaveTimer = null;
    for (const refs of [navCardRefs, brainCardRefs]) {
      if (!refs.saving) continue;
      refs.saving = false;
      refs.savedStamp = null;
      refs.keyStatus.classList.add('err');
      refs.keyStatus.textContent = 'could not save key';
    }
    pendingPrimarySaves.clear();
    primarySaveFailed = true;
    settlePrimarySave();
  }, 4000);
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
    row.title = item.report ? 'Show this result again' : 'Put this back in the box';

    const time = document.createElement('span');
    time.className = 'history-time';
    time.textContent = relativeTime(item.ts);
    row.appendChild(time);

    // A19: clicking a past test SHOWS it again. It used to re-fill the task box
    // and (from a suggestion-card tap) start a fresh, paid test — the one thing
    // someone looking back at a result does not want. Rows written before this
    // kept no report, so those still just re-fill the box.
    row.addEventListener('click', () => {
      if (busy) return;
      if (item.report) {
        clearFeed();
        renderResult({ ...item.report, reason: item.reason || item.report.reason, fromHistory: true, historyTs: item.ts, task: item.task });
        return;
      }
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

// ---- A7: document mode ------------------------------------------------------
//
// The panel used to take exactly one sentence. A person holding a spec, a PRD
// or a list of stories had nowhere to put it — pasting the whole thing in the
// task box sent it verbatim on every model call and quietly tested about 5% of
// it. Document mode is the missing first step: ONE planning call turns the
// document into a short list of separate, self-contained flows, the user sees
// that list and unticks anything they don't want, and then each ticked flow is
// tested as its own run, one after another, with one combined verdict at the
// end. Nothing is driven until the user has approved the list.

/** true while the task box is holding a document rather than one instruction. */
let docMode = false;
/** The in-flight sequence of flows, or null when a single test is running.
 * { flows:[{name,task}], index, results:[], cancelled } */
let flowQueue = null;
/** The flows last derived from the document, awaiting the user's tick-boxes. */
let derivedFlows = [];
/** True while we are waiting for the planning call to come back. */
let decomposing = false;

function runButtonLabel() {
  return docMode ? 'Find what to test' : 'Run test';
}

function setDocMode(on) {
  if (busy || flowQueue) return;
  docMode = !!on;
  modeTaskBtn.classList.toggle('mode-btn-on', !docMode);
  modeDocBtn.classList.toggle('mode-btn-on', docMode);
  modeTaskBtn.setAttribute('aria-pressed', String(!docMode));
  modeDocBtn.setAttribute('aria-pressed', String(docMode));
  suggestWrap.hidden = docMode;
  taskLabel.textContent = docMode ? 'Paste your spec, PRD or list of stories' : 'What should I test?';
  taskInput.rows = docMode ? 10 : 3;
  taskInput.placeholder = docMode
    ? 'Paste the whole thing — I\'ll work out the separate things to test and show you the list before running anything.'
    : 'e.g. Add an item to the cart and complete checkout';
  runBtn.textContent = runButtonLabel();
  hideFlowsCard();
}

modeTaskBtn.addEventListener('click', () => setDocMode(false));
modeDocBtn.addEventListener('click', () => setDocMode(true));

function hideFlowsCard() {
  flowsCard.hidden = true;
  flowsList.textContent = '';
  flowsNote.hidden = true;
  derivedFlows = [];
}

flowsCancelBtn.addEventListener('click', hideFlowsCard);

/** Ask for the flow list. The answer arrives as a 'flows' message. */
function requestFlows(spec) {
  decomposing = true;
  hideFlowsCard();
  runBtn.disabled = true;
  runBtn.textContent = 'Reading your document…';
  addProgressLine('Reading your document and working out what to test…');
  postToSW({ kind: 'decompose', spec, url: activeTab ? activeTab.url : undefined });
}

function endDecomposing() {
  decomposing = false;
  runBtn.textContent = runButtonLabel();
  refreshRunEnabled();
}

function onFlowsError(message) {
  endDecomposing();
  showError(message || "I couldn't turn that document into a list of things to test.");
}

function renderFlowChecklist(msg) {
  endDecomposing();
  const flows = Array.isArray(msg.flows) ? msg.flows : [];
  if (!flows.length) {
    showError("I couldn't find anything testable in that document. Try a shorter one, or write the flows as a list.");
    return;
  }
  derivedFlows = flows;
  flowsList.textContent = '';
  flows.forEach((f, i) => {
    const row = document.createElement('label');
    row.className = 'flow-row';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    box.setAttribute('data-flow-index', String(i));
    box.addEventListener('change', refreshFlowsRunBtn);
    const body = document.createElement('span');
    const name = document.createElement('span');
    name.className = 'flow-name';
    name.textContent = f && f.name ? String(f.name) : `Flow ${i + 1}`;
    const task = document.createElement('small');
    task.className = 'flow-task';
    task.textContent = f && f.task ? String(f.task) : '';
    body.appendChild(name);
    body.appendChild(task);
    row.appendChild(box);
    row.appendChild(body);
    flowsList.appendChild(row);
  });
  // The cap only exists when there is no desktop helper — every flow is a whole
  // extra test paid for with the user's own key.
  if (msg.truncated) {
    const total = typeof msg.total === 'number' ? msg.total : flows.length;
    flowsNote.textContent =
      `Your document had ${total} things to test in it. Without Spike Core (optional desktop helper) ` +
      `I'll run the first ${flows.length} — each one is a separate test paid for with your AI key. ` +
      `Connect Spike Core in Settings to run the rest.`;
    flowsNote.hidden = false;
  }
  refreshFlowsRunBtn();
  flowsCard.hidden = false;
  flowsCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function checkedFlows() {
  const out = [];
  flowsList.querySelectorAll('input[type="checkbox"]').forEach((box) => {
    if (!box.checked) return;
    const i = Number(box.getAttribute('data-flow-index'));
    if (derivedFlows[i]) out.push(derivedFlows[i]);
  });
  return out;
}

function refreshFlowsRunBtn() {
  const n = checkedFlows().length;
  flowsRunBtn.disabled = n === 0;
  flowsRunBtn.textContent = n === 1 ? 'Test this 1 flow' : `Test these ${n} flows`;
}

flowsRunBtn.addEventListener('click', () => {
  if (busy || flowQueue) return;
  const flows = checkedFlows();
  if (!flows.length) return;
  hideFlowsCard();
  hideError();
  resultCard.hidden = true;
  flowResults.hidden = true;
  resetFixUi();
  clearFeed();
  hideShot();
  flowQueue = { flows, index: 0, results: [], cancelled: false };
  runNextFlow();
});

/** Start the next flow in the queue, or finish up when they're all done. */
function runNextFlow() {
  if (!flowQueue) return;
  if (flowQueue.cancelled || flowQueue.index >= flowQueue.flows.length) {
    finishFlowQueue();
    return;
  }
  const flow = flowQueue.flows[flowQueue.index];
  // A24: a whole-site check counts pages, not flows — and it never signs in,
  // so the saved test login has nothing to add to a look-only page visit.
  addProgressLine(
    flowQueue.lookOnly
      ? `Page ${flowQueue.index + 1} of ${flowQueue.flows.length}: ${flow.name}`
      : `Flow ${flowQueue.index + 1} of ${flowQueue.flows.length}: ${flow.name}`,
  );
  setBusy(true);
  postToSW(buildRunMessage(flowQueue.lookOnly ? flow.task : withSavedLogin(flow.task)));
}

/** One flow finished (verdict or error). Record it and move on — one broken
 * flow must never hide the verdict of the others. */
function noteFlowOutcome(payload, verdict, reason) {
  if (!flowQueue) return;
  const flow = flowQueue.flows[flowQueue.index] || { name: `Flow ${flowQueue.index + 1}`, task: '' };
  flowQueue.results.push({
    name: flow.name,
    task: flow.task,
    verdict: String(verdict || 'uncertain').toLowerCase(),
    reason: String(reason || ''),
    payload: payload || null,
  });
  flowQueue.index += 1;
  runNextFlow();
}

/** fail beats uncertain beats pass — the same rule the command line uses. */
function aggregateFlowVerdict(results) {
  if (!results.length) return 'uncertain';
  if (results.some((r) => r.verdict === 'fail')) return 'fail';
  if (results.some((r) => r.verdict === 'uncertain')) return 'uncertain';
  return 'pass';
}

function finishFlowQueue() {
  const q = flowQueue;
  flowQueue = null;
  setBusy(false);
  if (!q || !q.results.length) return;
  // Show the report and fix prompt of the flow that most needs attention.
  const primary =
    q.results.find((r) => r.verdict === 'fail' && r.payload) ||
    q.results.find((r) => r.verdict === 'uncertain' && r.payload) ||
    [...q.results].reverse().find((r) => r.payload) ||
    q.results[q.results.length - 1];
  const base = (primary && primary.payload) ? { ...primary.payload } : {};
  base.verdict = aggregateFlowVerdict(q.results);
  base.flowOutcome = {
    flows: q.results.map((r) => ({ name: r.name, verdict: r.verdict, reason: r.reason })),
    attempted: q.results.length,
    total: q.flows.length,
    cancelled: q.cancelled,
  };
  // A24: a check closes with its own health + coverage sentence, in place of a
  // single test's reason line.
  if (q.lookOnly && checkStats) {
    base.checkSummary = renderCheckSummaryLine(q.results, checkStats);
    checkStats = null;
  }
  refreshCheckSiteBtn();
  renderResult(base);
}

/** The per-flow rows in the result card. Returns true when it rendered any. */
function renderFlowOutcome(outcome) {
  if (!outcome || !Array.isArray(outcome.flows) || !outcome.flows.length) {
    flowResults.hidden = true;
    flowResults.textContent = '';
    return false;
  }
  flowResults.textContent = '';
  const TAG_CLASS = { pass: 'verdict-pass', fail: 'verdict-fail', uncertain: 'verdict-uncertain' };
  const TAG_TEXT = { pass: 'PASS', fail: 'FAIL', uncertain: 'UNSURE' };
  for (const f of outcome.flows) {
    const row = document.createElement('div');
    row.className = 'flow-result';
    const tag = document.createElement('span');
    tag.className = `flow-result-tag ${TAG_CLASS[f.verdict] || 'verdict-uncertain'}`;
    tag.textContent = TAG_TEXT[f.verdict] || 'UNSURE';
    const body = document.createElement('span');
    body.className = 'flow-result-body';
    body.textContent = f.name;
    if (f.verdict !== 'pass' && f.reason) {
      const why = document.createElement('small');
      why.className = 'flow-result-reason';
      why.textContent = f.reason;
      body.appendChild(why);
    }
    row.appendChild(tag);
    row.appendChild(body);
    flowResults.appendChild(row);
  }
  if (outcome.attempted < outcome.total) {
    const note = document.createElement('div');
    note.className = 'flow-result';
    note.textContent = `Stopped after ${outcome.attempted} of ${outcome.total} flows.`;
    flowResults.appendChild(note);
  }
  flowResults.hidden = false;
  return true;
}

// ---- A24: "Check this site" -------------------------------------------------
//
// The way in that asks for nothing. It finds the pages on the site, then looks
// at each one in turn — no clicking, no typing — and rolls the answers into a
// single "here is what's broken". The per-page tests go through exactly the
// same queue a pasted document's flows use, so there is one place that decides
// what the overall answer is.

/** Set while a check is finding its pages, so the button can't be tapped twice
 * and the spinner state means something. */
let findingPages = false;
/** Counts carried from the page-finding step into the closing sentence. */
let checkStats = null;

function setCheckNote(text) {
  if (!checkSiteNote) return;
  checkSiteNote.textContent = text || '';
  checkSiteNote.hidden = !text;
}

function refreshCheckSiteBtn() {
  if (!checkSiteBtn) return;
  checkSiteBtn.disabled = busy || findingPages || !!flowQueue;
}

function startSiteCheck() {
  if (busy || findingPages || flowQueue) return;
  if (missingAiKey()) {
    showKeyCta();
    return;
  }
  if (!activeTab || !isTestableUrl(activeTab.url)) {
    showError('Switch to the tab with your site, then come back here.');
    return;
  }
  hideError();
  setCheckNote('');
  resultCard.hidden = true;
  flowResults.hidden = true;
  hideShot();
  resetFixUi();
  clearFeed();
  findingPages = true;
  refreshCheckSiteBtn();
  addProgressLine('Looking around your site to see what pages there are…');
  postToSW({ kind: 'check-site', url: activeTab.url });
}

/** The pages came back. Turn each one into a test and hand the list to the
 * queue that already knows how to run a sequence and aggregate it. */
function onCheckPages(msg) {
  findingPages = false;
  refreshCheckSiteBtn();
  const pages = Array.isArray(msg.pages) ? msg.pages : [];
  if (!pages.length) {
    onCheckError('I could not find any pages to look at on that site.');
    return;
  }
  checkStats = {
    controlsFound: Number(msg.controlsFound) || 0,
    capped: !!msg.capped,
    liteCap: Number(msg.liteCap) || 0,
  };
  if (checkStats.capped && checkStats.liteCap) {
    setCheckNote(`Without the optional desktop helper a check looks at up to ${checkStats.liteCap} pages. Install it to check the whole site at once.`);
  } else if (checkStats.capped) {
    setCheckNote('This site has more pages than one check covers — I looked at the main ones.');
  }
  addProgressLine(`Found ${pages.length} page${pages.length === 1 ? '' : 's'}. Looking at each one…`);
  flowQueue = {
    flows: pages.map((p) => ({ name: p.name || p.url, task: p.task })),
    index: 0,
    results: [],
    cancelled: false,
    // A24: a check is look-only whatever the click-and-type box says — the user
    // asked "is anything broken", not "go press things on my site".
    lookOnly: true,
  };
  refreshCheckSiteBtn();
  runNextFlow();
}

function onCheckError(message) {
  findingPages = false;
  checkStats = null;
  refreshCheckSiteBtn();
  setBusy(false);
  showError(message || 'I could not look around that site.');
}

/** The closing sentence of a check. Counts controls FOUND rather than pressed:
 * a look-only check never presses anything, so "0 controls" would be true and
 * useless — the number is there to say how much of the site was in view. */
function renderCheckSummaryLine(results, stats) {
  const word = (n, one) => `${n} ${n === 1 ? one : one + 's'}`;
  const problems = results.filter((r) => r.verdict === 'fail').length;
  const found = problems === 0
    ? 'nothing looked broken'
    : `${word(problems, 'problem')} — ${problems === 1 ? 'it is' : 'they are'} listed below`;
  return `Checked ${word(results.length, 'page')} and ${word(stats.controlsFound, 'control')} on them; ${found}.`;
}

if (checkSiteBtn) checkSiteBtn.addEventListener('click', startSiteCheck);

// ---- run -------------------------------------------------------------------
/** The run message for one instruction — shared by a single test and by every
 * flow in a document run, so consent/look-only behave identically in both. */
function buildRunMessage(task) {
  // A1 (P0): the consent checkbox IS the look-only switch. Checked → the agent
  // may click and type on this site (its host is allow-listed for this run).
  // Unchecked → look-only mode: it navigates and checks, never interacts.
  // A24: a check the user never wrote a word for is always look-only — it asked
  // "is anything broken", not "go press things on my site". Otherwise the
  // consent checkbox IS the switch.
  const lookOnly = (flowQueue && flowQueue.lookOnly) || !consentToggle.checked;
  const runMsg = { kind: 'run', task, tabId: activeTab.id, url: activeTab.url, readOnly: lookOnly };
  lastStartedTask = task;
  if (!lookOnly) {
    const host = hostOf(activeTab.url);
    if (host) runMsg.allowHost = host;
    // A14: sites the user has already said yes to while testing this one. The
    // question is asked once per pair and then never again.
    const extras = allowedExtrasFor(host);
    if (extras.length) runMsg.allowHosts = extras;
  }
  // A25: reuse (and refresh) the sign-in remembered for this site. Only Spike
  // Core can hold it, so the option isn't even offered without one.
  if (rememberLogin && rememberLogin.checked && bridgeHealthy()) runMsg.rememberLogin = true;
  return runMsg;
}

function startRun(task) {
  if (busy) return;
  // A4: no key, no run — the suggestion cards used to start one and fail a few
  // seconds later. Say what's missing and offer the way to fix it instead.
  if (missingAiKey()) {
    showKeyCta();
    return;
  }
  if (!activeTab || !isTestableUrl(activeTab.url)) {
    showError('Switch to the tab with your site, then come back here.');
    return;
  }
  // A7: in document mode "Run" does not drive anything — it works out the list
  // of flows first and hands it back for the user to approve.
  if (docMode) {
    const spec = (task || '').trim();
    if (!spec) {
      showError('Paste your spec, PRD or list of stories first.');
      taskInput.focus();
      return;
    }
    hideError();
    resultCard.hidden = true;
    clearFeed();
    requestFlows(spec);
    return;
  }
  const t = withSavedLogin((task || '').trim());
  if (!t) {
    showError('Tell me what to test first, or tap one of the suggestions above.');
    taskInput.focus();
    return;
  }
  hideError();
  resultCard.hidden = true;
  flowResults.hidden = true;
  hideShot();
  resetFixUi();
  clearFeed();
  addProgressLine(`Asking the agent to test: ${activeTab.url}`);
  // optimistic; the SW confirms with 'accepted' or 'error'
  setBusy(true);
  noteRunStarted();
  postToSW(buildRunMessage(t));
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
  // A10: the tab, when we already know it — the worker keeps the last result
  // per tab and replays it in the answer to this.
  postToSW({ kind: 'status', tabId: activeTab ? activeTab.id : undefined });
  // fetch the planner/debug config so debugMode is known before the first result
  postToSW({ kind: 'config-get' });
}

initTheme();
loadHelperSeen();
loadRunCount();
loadRememberLogin();
loadActiveTab();
requestInitialState();
probeInstallReachable();
loadAllowedHostPairs();
void loadHistory().then(renderHistory);

// poll the bridge connection so the dot stays accurate
setInterval(() => {
  postToSW({ kind: 'bridge-status' });
  // A10: while a test is marked as running, keep asking how it is doing. Its
  // messages can stop arriving — the panel was closed when it finished, or
  // Chrome put the extension to sleep mid-test — and without this the panel
  // sits on a spinner for a test that ended long ago.
  if (busy) postToSW({ kind: 'status', tabId: activeTab ? activeTab.id : undefined });
}, 3000);
