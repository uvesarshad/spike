/* Service worker — the extension side of the daemon↔extension bridge.
 *
 * Connects out to the daemon's WebSocket bridge (ws://localhost:9410/) and lets
 * the daemon drive Chrome through chrome.debugger. This is the transport behind
 * ExtensionBrowser (src/ports/extension-browser.ts).
 *
 * Wire protocol (JSON, one object per message):
 *   daemon→ext request : { id, method, params? }
 *   ext→daemon response: { id, result? | error? }
 *   ext→daemon event   : { event, params }   (forwarded chrome.debugger events + lifecycle)
 *
 * PROTOCOL VERSION HANDSHAKE (A4): our `hello` carries `protocolVersion`
 * (this build's wire-protocol version); a daemon that understands the
 * handshake replies with `{event:'bridge.hello', params:{protocolVersion}}`.
 * If that ack never arrives (pre-handshake daemon) or reports a version below
 * MIN_DAEMON_PROTOCOL_VERSION, we treat the daemon as outdated — connected at
 * the socket level, but NOT reported to the panel as healthy — see
 * handleDaemonHello/bridge-status below and src/bridge/bridge-server.ts.
 *
 * MV3 realities handled here:
 *   - no window/DOM: use self/globalThis; WebSocket is available in the SW.
 *   - the SW can be torn down at any time: reconnect loop with backoff, and a
 *     chrome.alarms keepalive ping so it isn't evicted mid-run.
 *
 * LITE MODE: when NO daemon is connected, the panel's run/config/key messages are
 * served LOCALLY by running the bundled engine (./lite-engine.js) in this SW —
 * keys + settings live in chrome.storage.local and the page is driven via
 * chrome.debugger directly. The manifest declares this SW as a module so the
 * static import below works. Pro mode (daemon present) is unchanged.
 */

import { runLite, buildLiteConfig, DEFAULT_SETTINGS, decomposeSpecLite, LITE_MAX_FLOWS } from './lite-engine.js';

// MANIFEST_VARIANT: token-replaced at pack time by scripts/pack-extension.ts
// (see stageVariant() there) — 'default' ships with extension/manifest.json
// (host_permissions <all_urls>, full functionality); 'activetab' ships with
// extension/manifest.activetab.json (no <all_urls>, activeTab instead). An
// unpacked/dev-loaded extension always runs the literal default below since
// there's no pack step. When this is 'activetab' the extension has no
// standing permission to act on tabs the user hasn't explicitly engaged —
// see the MANIFEST_VARIANT gate in attachDebugger() further down.
const MANIFEST_VARIANT = 'default';

/* The daemon's bridge usually listens on 9410 (config default), but tests and
 * multi-instance setups bind nearby ports — the reconnect loop scans a small
 * candidate list round-robin. The list can be PINNED per Chrome instance via
 * chrome.storage.local {bridgePorts:[...]} (the dev-loader sets it), which is
 * how two Chromes running this extension stay out of each other's bridges. */
const DEFAULT_BRIDGE_PORTS = [9410, 9411, 9412, 9413];
let bridgePorts = DEFAULT_BRIDGE_PORTS;
let bridgePortIdx = 0;
try {
  chrome.storage.local.get('bridgePorts', (v) => {
    if (Array.isArray(v?.bridgePorts) && v.bridgePorts.length) {
      bridgePorts = v.bridgePorts.map(Number).filter((n) => Number.isFinite(n));
      bridgePortIdx = 0;
      log('bridge ports pinned to', bridgePorts.join(','));
      // drop any connection made with the default list and redial
      if (ws) { try { ws.close(); } catch { /* noop */ } }
      connect();
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.bridgePorts) return;
    const next = changes.bridgePorts.newValue;
    if (Array.isArray(next) && next.length) {
      bridgePorts = next.map(Number).filter((n) => Number.isFinite(n));
      bridgePortIdx = 0;
      log('bridge ports re-pinned to', bridgePorts.join(','));
      if (ws) { try { ws.close(); } catch { /* noop */ } }
      connect();
    }
  });
} catch { /* storage unavailable — defaults stand */ }

// A2: pairing token — minted ONCE on first install and persisted in
// chrome.storage.local, presented in every `hello` frame. The daemon's bridge
// (src/bridge/bridge-server.ts) trusts the FIRST token it ever sees (persisted
// in its own Vault) and rejects any later connection whose token doesn't
// match — this is what actually closes "any local process can connect".
let pairingToken = null;
const pairingTokenReady = new Promise((resolve) => {
  try {
    chrome.storage.local.get('pairingToken', (v) => {
      if (v && typeof v.pairingToken === 'string' && v.pairingToken) {
        pairingToken = v.pairingToken;
        resolve(pairingToken);
        return;
      }
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      const token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      chrome.storage.local.set({ pairingToken: token }, () => {
        pairingToken = token;
        resolve(token);
      });
    });
  } catch {
    resolve(null); // storage unavailable — hello goes out without a token (daemon will reject it)
  }
});

const DEBUGGER_VERSION = '1.3';
const NAVIGATE_TIMEOUT_MS = 30_000;

// Bridge wire-protocol version this extension build speaks — bump in lockstep
// with PROTOCOL_VERSION in src/bridge/bridge-server.ts whenever the daemon↔
// extension wire protocol changes in a way both sides must agree on.
const PROTOCOL_VERSION = 1;
// Lowest daemon protocol version this build can drive reliably. A daemon that
// never acks the handshake (pre-handshake code) or acks below this is treated
// as outdated: we'd rather tell the user to update than show a green dot over
// a connection that silently can't run tests correctly.
const MIN_DAEMON_PROTOCOL_VERSION = 1;
// How long to wait for the daemon's `bridge.hello` ack before assuming it
// predates the handshake (localhost round-trip is normally near-instant).
const HANDSHAKE_TIMEOUT_MS = 4000;

let ws = null;
let reconnectDelay = 500; // backoff, capped below
let connecting = false;
// Daemon protocol-version handshake state — reset on every fresh connection.
let daemonProtocolVersion = null; // number once acked, else null (unknown/pending)
let daemonCompatible = null;      // true | false | null (null = handshake still pending)
let handshakeTimer = null;

/** tabIds we have an attached chrome.debugger session for. */
const attached = new Set();

function log(...args) {
  console.log('[spike:sw]', ...args);
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function respond(id, result) {
  send({ id, result });
}

function respondError(id, error) {
  send({ id, error: String(error && error.message ? error.message : error) });
}

function emit(event, params) {
  send({ event, params });
}

// ---- ext→daemon requests (vibe: panel drives runs through here) -------------
//
// The panel (side panel) cannot talk to the daemon directly. It connects to the
// SW over a chrome.runtime port; the SW forwards run/status calls to the daemon
// as a NEW request frame { rid, method, params? } and matches the daemon's
// { rid, result|error } response back to the awaiting promise.

let ridCounter = 0;
const pendingRequests = new Map(); // rid -> { resolve, reject, timer }
const REQUEST_TIMEOUT_MS = 120_000;

function sendRequest(method, params) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('daemon not running — start it with: spike daemon'));
      return;
    }
    const rid = ++ridCounter;
    const timer = setTimeout(() => {
      if (pendingRequests.has(rid)) {
        pendingRequests.delete(rid);
        reject(new Error(`request ${method} timed out`));
      }
    }, REQUEST_TIMEOUT_MS);
    pendingRequests.set(rid, { resolve, reject, timer });
    try {
      send({ rid, method, params: params || {} });
    } catch (e) {
      clearTimeout(timer);
      pendingRequests.delete(rid);
      reject(e);
    }
  });
}

function resolveRequest(msg) {
  const entry = pendingRequests.get(msg.rid);
  if (!entry) return;
  pendingRequests.delete(msg.rid);
  clearTimeout(entry.timer);
  if (msg.error !== undefined && msg.error !== null) {
    entry.reject(new Error(String(msg.error && msg.error.message ? msg.error.message : msg.error)));
  } else {
    entry.resolve(msg.result);
  }
}

// ---- vibe panel ports ------------------------------------------------------
//
// The side panel opens a long-lived port named 'vibe-panel'. The SW relays
// daemon vibe.* events to every connected panel port and answers the panel's
// run/status/nano/bridge-status messages.

const panelPorts = new Set();

/** tabId of the active vibe run (the panel's current tab) — captured from the
 * vibe.run we forward, so vibe.done/vibe.error can tell the page overlay to clear. */
let lastRunTabId = null;

function broadcastToPanels(message) {
  for (const port of panelPorts) {
    try {
      port.postMessage(message);
    } catch {
      panelPorts.delete(port); // port closed under us
    }
  }
}

/** Route a vibe.cursor event to the page's overlay content script. */
function routeCursorToOverlay(params) {
  if (!params || params.tabId === undefined) return;
  try {
    chrome.tabs.sendMessage(
      params.tabId,
      { target: 'qa-overlay', ...params },
      () => { void chrome.runtime.lastError; }, // swallow — tab may lack the content script
    );
  } catch {
    /* fire-and-forget */
  }
}

/** Tell the page overlay (green glow + badge) to clear. Fire-and-forget. */
function sendOverlayEnd(tabId) {
  if (tabId === null || tabId === undefined) return;
  try {
    chrome.tabs.sendMessage(
      tabId,
      { target: 'qa-overlay', kind: 'end' },
      () => { void chrome.runtime.lastError; }, // swallow — tab may lack the content script
    );
  } catch {
    /* fire-and-forget */
  }
}

/** True once the socket is open AND the protocol handshake didn't come back
 * incompatible. Gates every daemon-only UI affordance (auto-fix, clips) — a
 * daemon that's merely socket-connected but too old to speak our protocol
 * must not be treated as usable. */
function bridgeHealthy() {
  return daemonConnected() && daemonCompatible !== false;
}

/** Build the { kind:'bridge-status', ... } payload the panel renders. */
function bridgeStatusPayload() {
  const connected = daemonConnected();
  return {
    kind: 'bridge-status',
    connected,
    protocolVersion: connected ? daemonProtocolVersion : null,
    compatible: connected ? daemonCompatible : null,
  };
}

/** Handle the daemon's { event:'bridge.hello', params:{protocolVersion} } ack
 * (see src/bridge/bridge-server.ts). Resolves the handshake and pushes the
 * result to every open panel immediately, rather than waiting for the next
 * 3s bridge-status poll. */
function handleDaemonHello(params) {
  if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null; }
  const v = params && typeof params.protocolVersion === 'number' ? params.protocolVersion : null;
  daemonProtocolVersion = v;
  daemonCompatible = v !== null && v >= MIN_DAEMON_PROTOCOL_VERSION;
  broadcastToPanels(bridgeStatusPayload());
}

/** Dispatch a daemon event frame { event, params }. */
function handleBridgeEvent(event, params) {
  if (event === 'bridge.hello') {
    handleDaemonHello(params);
    return;
  }
  if (event === 'vibe.cursor') {
    routeCursorToOverlay(params);
  }
  // Run finished (or failed): clear the page overlay on the run's tab.
  if (event === 'vibe.done' || event === 'vibe.error') {
    sendOverlayEnd(lastRunTabId);
  }
  // A10: remember the verdict (and write its "recent tests" row) even when no
  // panel is open to receive the message below.
  if (event === 'vibe.done') {
    void rememberRunResult(lastRunTabId, params || {}, { task: lastRunTask });
  }
  if (typeof event === 'string' && event.startsWith('vibe.')) {
    // strip the 'vibe.' prefix into a panel message kind: vibe.progress -> progress
    // (this generic fan-out already covers vibe.step → 'step', vibe.done → 'done', …)
    const kind = event.slice('vibe.'.length);
    broadcastToPanels({ kind, ...(params || {}) });
  }
}

// ============================================================================
// LITE MODE — run the bundled engine in this SW when no daemon is connected.
// ============================================================================

/** Daemon present? Pro mode uses it; otherwise we run lite, in-SW. */
function daemonConnected() {
  return !!(ws && ws.readyState === WebSocket.OPEN);
}

/** In-SW CDP event subscribers — the lite engine's CdpTransport.subscribe taps
 * these (filled by the chrome.debugger.onEvent fan-out above). */
const localCdpListeners = new Set();

/** provider id (panel) → chrome.storage key name (the vault CONTRACT name). */
const LITE_KEY_NAME = { gemini: 'gemini', claude: 'anthropic', gpt: 'openai', openrouter: 'openrouter', glm: 'glm' };

/* chrome.storage.local key names. The `qa*` pair is the pre-Spike naming, kept
 * only so an already-installed extension doesn't lose its stored API keys and
 * settings on upgrade — migrateLegacyStorage() moves them across once, then the
 * old entries are gone. Drop the LEGACY_* constants and the migration at 1.0
 * (same sweep as src/env-compat.ts). */
const KEYS_STORAGE_KEY = 'spikeKeys';
const SETTINGS_STORAGE_KEY = 'spikeSettings';
/* A5: the test login the panel's optional card collected, kept on this machine
 * only. Without the desktop helper there is no encrypted store to put it in, so
 * it lives in the browser's own storage for this extension — the point of the
 * card is that the value stops being typed into the task box, where it was
 * ending up in saved runs, recorded tests and prompts people paste elsewhere.
 * Same two names as the helper: TEST_USER / TEST_PASSWORD, nothing else. */
const TEST_SECRETS_STORAGE_KEY = 'spikeTestSecrets';
const TEST_LOGIN_SECRET_NAMES = ['TEST_USER', 'TEST_PASSWORD'];
const LEGACY_STORAGE_KEYS = [['qaKeys', KEYS_STORAGE_KEY], ['qaSettings', SETTINGS_STORAGE_KEY]];

function storageGet(key) {
  return new Promise((resolve) => chrome.storage.local.get(key, (v) => resolve(v && v[key])));
}
function storageSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, () => resolve()));
}
function storageRemove(key) {
  return new Promise((resolve) => chrome.storage.local.remove(key, () => resolve()));
}

/** Copy any pre-Spike storage entry onto its new name and delete the old one.
 * A value already under the new name always wins (never clobbered). Idempotent
 * and cheap, which matters because an MV3 worker restart re-runs it. */
async function migrateLegacyStorage() {
  for (const [oldKey, newKey] of LEGACY_STORAGE_KEYS) {
    const legacy = await storageGet(oldKey);
    if (legacy === undefined) continue;
    if ((await storageGet(newKey)) === undefined) await storageSet({ [newKey]: legacy });
    await storageRemove(oldKey);
  }
}

/* Memoized so concurrent readers share one migration pass. Reset on worker
 * restart, which is harmless — the migration is a no-op once it has run. */
let legacyStorageMigration = null;
function ensureStorageMigrated() {
  legacyStorageMigration ??= migrateLegacyStorage().catch(() => { legacyStorageMigration = null; });
  return legacyStorageMigration;
}

async function getKeys() {
  await ensureStorageMigrated();
  return (await storageGet(KEYS_STORAGE_KEY)) || {};
}
async function getSettings() {
  await ensureStorageMigrated();
  const s = (await storageGet(SETTINGS_STORAGE_KEY)) || {};
  return {
    planner: { ...DEFAULT_SETTINGS.planner, ...(s.planner || {}) },       // BRAIN role
    navigator: { ...DEFAULT_SETTINGS.navigator, ...(s.navigator || {}) }, // NAVIGATOR role
    debugMode: s.debugMode || DEFAULT_SETTINGS.debugMode,
    debugAgent: s.debugAgent || DEFAULT_SETTINGS.debugAgent,
    videoAssertions: Boolean(s.videoAssertions ?? DEFAULT_SETTINGS.videoAssertions),
    // safety guardrails: read-only defaults ON (first runs never mutate); spend cap OFF (undefined) unless set.
    readOnly: Boolean(s.readOnly ?? DEFAULT_SETTINGS.readOnly),
    spendCapUsd: typeof s.spendCapUsd === 'number' && s.spendCapUsd > 0 ? s.spendCapUsd : undefined,
    // A1: deterministic-verdicts toggle, safe-by-default true (mirrors readOnly).
    strictOracles: Boolean(s.strictOracles ?? DEFAULT_SETTINGS.strictOracles),
  };
}
async function liteSetKey(provider, key) {
  const name = LITE_KEY_NAME[provider];
  if (!name) throw new Error(`provider ${provider} takes no key`);
  if (!key) throw new Error('a non-empty key is required');
  const keys = await getKeys();
  keys[name] = String(key);
  await storageSet({ [KEYS_STORAGE_KEY]: keys });
}
async function liteClearKey(provider) {
  const name = LITE_KEY_NAME[provider];
  if (!name) throw new Error(`provider ${provider} takes no key`);
  const keys = await getKeys();
  const had = name in keys;
  delete keys[name];
  await storageSet({ [KEYS_STORAGE_KEY]: keys });
  return had;
}
async function getTestSecrets() {
  return (await storageGet(TEST_SECRETS_STORAGE_KEY)) || {};
}
/** Refuse any name but the two test-login fields — this store also has to be
 * safe to hand a panel, exactly like the API-key path. */
function requireTestLoginName(name) {
  if (!TEST_LOGIN_SECRET_NAMES.includes(name)) throw new Error(`"${name}" is not a test-login field`);
  return name;
}
async function liteSetTestSecret(name, value) {
  requireTestLoginName(name);
  if (!value) throw new Error('a non-empty value is required');
  const secrets = await getTestSecrets();
  secrets[name] = String(value);
  await storageSet({ [TEST_SECRETS_STORAGE_KEY]: secrets });
}
async function liteClearTestSecret(name) {
  requireTestLoginName(name);
  const secrets = await getTestSecrets();
  const had = name in secrets;
  delete secrets[name];
  await storageSet({ [TEST_SECRETS_STORAGE_KEY]: secrets });
  return had;
}
async function liteSetSettings(patch) {
  const cur = await getSettings();
  const next = {
    debugMode: patch.debugMode || cur.debugMode,
    debugAgent: patch.debugAgent || cur.debugAgent,
    videoAssertions:
      patch.videoAssertions !== undefined ? Boolean(patch.videoAssertions) : Boolean(cur.videoAssertions),
    readOnly:
      patch.readOnly !== undefined ? Boolean(patch.readOnly) : Boolean(cur.readOnly),
    // number > 0 sets a cap; 0 / null / non-number clears it (OFF).
    spendCapUsd:
      patch.spendCapUsd !== undefined
        ? (typeof patch.spendCapUsd === 'number' && patch.spendCapUsd > 0 ? patch.spendCapUsd : undefined)
        : cur.spendCapUsd,
    strictOracles:
      patch.strictOracles !== undefined ? Boolean(patch.strictOracles) : Boolean(cur.strictOracles),
    planner: { ...cur.planner, ...(patch.planner || {}) },        // BRAIN role
    navigator: { ...cur.navigator, ...(patch.navigator || {}) },  // NAVIGATOR role
  };
  await storageSet({ [SETTINGS_STORAGE_KEY]: next });
  return next;
}

// Nano (rung 0) callbacks for the lite engine — wired to the SW's existing nano
// plumbing (SW-direct or offscreen), with the same timeouts the bridge path uses.
const liteNanoDeps = {
  avail: () => Promise.race([nanoAvail(), new Promise((r) => setTimeout(() => r('unavailable'), 10_000))]),
  warmup: () => withSwTimeout(nanoWarmup(), 120_000, 'nano.warmup'),
  verdict: (dataUrl, task) => withSwTimeout(nanoVerdict(dataUrl, task), 5 * 60_000, 'nano.verdict'),
  navStep: (prompt, schema) => withSwTimeout(nanoNavStep(prompt, schema), 2 * 60_000, 'nano.navStep'),
};

/** chrome.debugger-backed browser deps bound to one tab, injected into runLite. */
function makeLiteBrowserDeps(tabId) {
  return {
    transport: {
      send: (method, params) => sendCdp(tabId, method, params),
      subscribe: (handler) => {
        const fn = (evTabId, method, params) => { if (evTabId === tabId) handler(method, params); };
        localCdpListeners.add(fn);
        return () => localCdpListeners.delete(fn);
      },
    },
    navigate: (url) => navigateTab(tabId, url),
    getUrl: async () => (await getTab(tabId)).url || '',
    detach: () => detachDebugger(tabId), // keep the user's tab open
    onCursor: (params) => routeCursorToOverlay({ tabId, ...params }),
  };
}

let liteBusy = false;
let liteAbort = null;
/* A23 (lite path): set right before liteAbort.abort() by the chrome.debugger.
 * onDetach handler below, so runLiteFromPanel can report a clear reason
 * instead of whatever opaque error the lite engine surfaces for a plain
 * aborted signal (it just says "cancelled by user", same as any other
 * cancellation — not helpful when what actually happened is Chrome's
 * debugging session got closed out from under it). */
let liteAbortReason = null;
let lastLiteBundle = null; // for a future "download report" affordance

/* A22: MV3 can tear this SW down mid-run (long Nano/BYOK awaits with no
 * chrome.* touches invite eviction) — when it restarts, liteBusy/liteAbort
 * are gone and the panel's next status poll just gets busy:false, silently.
 * We checkpoint {runId, startedAt, task} to chrome.storage.session (survives
 * SW restarts, cleared on browser close — unlike storage.local) at run start
 * and clear it on completion. On a fresh SW init (see the IIFE below) a
 * leftover checkpoint means the PRIOR run never got to clear it — i.e. the SW
 * was evicted/crashed mid-run — so we record it in memory as `orphanedRun`
 * for the panel's status poll to report. */
const LITE_RUN_CHECKPOINT_KEY = 'spikeLiteRunCheckpoint';
/** {runId, startedAt, task} of a run whose checkpoint survived a SW restart
 * (i.e. the SW was evicted/crashed mid-run) — null once reported and a fresh
 * run starts, or if this SW start is a normal (non-orphaned) one. */
let orphanedRun = null;

function sessionGet(key) {
  return new Promise((resolve) => {
    try { chrome.storage.session.get(key, (v) => resolve(v && v[key])); }
    catch { resolve(undefined); }
  });
}
function sessionSet(obj) {
  return new Promise((resolve) => {
    try { chrome.storage.session.set(obj, () => resolve()); }
    catch { resolve(); }
  });
}
function sessionRemove(key) {
  return new Promise((resolve) => {
    try { chrome.storage.session.remove(key, () => resolve()); }
    catch { resolve(); }
  });
}

/* A10: a finished test the panel never got to show.
 *
 * A verdict used to reach the UI ONLY as a live message to an open side panel.
 * Close the panel to watch the page — the thing people naturally do while a
 * test runs — and the result, the fix prompt and the "recent tests" row were
 * all simply gone when it was reopened. Both halves of the fix live here, in
 * the worker, rather than in the panel:
 *
 *   1. the finished payload is written to session storage keyed by the tab it
 *      ran on (kept until Chrome closes, like the run checkpoint above) and
 *      replayed to a panel the moment it connects or asks how things stand;
 *   2. the "recent tests" row is written HERE, when the run finishes, instead
 *      of by the panel on receipt — so it is written whether or not anything
 *      is listening.
 */
const LAST_RESULT_KEY = 'spikeLastResult';
/** How many tabs' results to keep. A browser can have hundreds of tabs open;
 * the panel only ever asks about one, so this is just a bound on the store. */
const LAST_RESULT_TABS = 5;
/** The "recent tests" list the panel renders — written here, read there. */
const HISTORY_STORAGE_KEY = 'qaHistory';
const HISTORY_CAP = 10;

/** What the user asked for, for the run in flight — the panel's task box may
 * be empty or already retyped by the time the run ends (or closed entirely). */
let lastRunTask = '';

/* Kept on this machine, but a saved row outlives the run and gets read back on
 * screen — so a password typed straight into the task box ("log in with
 * me@x.com / hunter2") must not be what we keep. The live run still gets the
 * original text; only the stored copy is trimmed. A {{secret:NAME}} reference
 * is stepped over: it holds no value, and it is the form we want people using.
 * Mirrors src/report/redact.ts (and, before A10, panel.js). */
const SECRET_PLACEHOLDER_RE = /\{\{secret:[a-zA-Z0-9_-]+\}\}/g;
const TASK_SECRET_PATTERNS = [
  /\b\S+@\S+\s*\/\s*\S+/g,
  /\b(?:password|passcode|passwd|pwd|pin|otp|token)\s*[:=]\s*\S+/gi,
];
function redactTaskSegment(segment) {
  let out = segment;
  for (const re of TASK_SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, '[redacted]');
  }
  return out;
}
function redactTaskText(task) {
  if (!task) return task;
  let out = '';
  let last = 0;
  SECRET_PLACEHOLDER_RE.lastIndex = 0;
  for (let m = SECRET_PLACEHOLDER_RE.exec(task); m; m = SECRET_PLACEHOLDER_RE.exec(task)) {
    out += redactTaskSegment(task.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + redactTaskSegment(task.slice(last));
}

/** Write one row of the "recent tests" list and hand the fresh list to any
 * open panel (which would otherwise have to re-read storage to notice). */
async function appendHistoryEntry(task, done) {
  const entry = {
    ts: Date.now(),
    task: redactTaskText(String(task || '')).slice(0, 80),
    verdict: String((done && done.verdict) || 'uncertain'),
    reason: String((done && (done.plainReport || done.reason)) || '').slice(0, 120),
  };
  const stored = await storageGet(HISTORY_STORAGE_KEY);
  const list = [entry, ...(Array.isArray(stored) ? stored : [])].slice(0, HISTORY_CAP);
  await storageSet({ [HISTORY_STORAGE_KEY]: list });
  broadcastToPanels({ kind: 'history', entries: list });
  return list;
}

/** The screenshots and report a run produced are far too big to keep in
 * storage (one full-page image is megabytes) — this is the small "there IS a
 * report for this run" note that a reopened panel can act on. */
function describeBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') return null;
  return {
    runId: bundle.runId || null,
    screenshotCount: Array.isArray(bundle.screenshots) ? bundle.screenshots.length : 0,
    reportBytes: typeof bundle.reportJson === 'string' ? bundle.reportJson.length : 0,
  };
}

async function readLastResults() {
  const stored = await sessionGet(LAST_RESULT_KEY);
  return stored && typeof stored === 'object' ? stored : {};
}

/** Remember a finished run (and write its history row) so a panel that was
 * closed when it ended can still show the verdict and the fix prompt. */
async function rememberRunResult(tabId, done, extra) {
  const task = (extra && extra.task) || lastRunTask || '';
  try { await appendHistoryEntry(task, done); } catch { /* the list is a nicety, never fatal */ }
  if (typeof tabId !== 'number' || !done || typeof done !== 'object') return;
  try {
    const all = await readLastResults();
    // savedAt doubles as the "have I already shown this one?" marker a panel is
    // compared against, so two results a millisecond apart must not look alike.
    const prev = all[String(tabId)];
    const savedAt = Math.max(Date.now(), (prev && prev.savedAt ? prev.savedAt : 0) + 1);
    all[String(tabId)] = {
      done,
      task,
      savedAt,
      bundle: describeBundle(extra && extra.bundle),
    };
    const kept = Object.entries(all)
      .sort((a, b) => ((b[1] && b[1].savedAt) || 0) - ((a[1] && a[1].savedAt) || 0))
      .slice(0, LAST_RESULT_TABS);
    await sessionSet({ [LAST_RESULT_KEY]: Object.fromEntries(kept) });
  } catch { /* storage full/unavailable — the live message still went out */ }
}

/** Drop the stored result for a tab — called when a new run starts on it, so a
 * panel reopened mid-run is never shown the PREVIOUS verdict as if it were the
 * current one. */
async function forgetRunResult(tabId) {
  if (typeof tabId !== 'number') return;
  try {
    const all = await readLastResults();
    if (!(String(tabId) in all)) return;
    delete all[String(tabId)];
    await sessionSet({ [LAST_RESULT_KEY]: all });
  } catch { /* nothing to lose */ }
}

/** The tab the panel is looking at, when it didn't tell us. */
function activeTabId() {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        void chrome.runtime.lastError;
        resolve(tabs && tabs[0] && typeof tabs[0].id === 'number' ? tabs[0].id : null);
      });
    } catch { resolve(null); }
  });
}

/** Which stored result we have already handed each open panel, so a panel that
 * asks how things stand every few seconds isn't re-shown the same verdict. */
const panelReplayedAt = new WeakMap();

/** Hand a just-connected (or just-asking) panel the last finished result for
 * its tab, shaped exactly like the live one plus `restored: true`. */
async function replayLastResult(port, tabId) {
  if (liteBusy) return; // a run is in flight; its own messages are the truth
  let id = typeof tabId === 'number' ? tabId : await activeTabId();
  let all;
  try { all = await readLastResults(); } catch { return; }
  let entry = id === null ? null : all[String(id)];
  // The panel may be pointed at a tab that never ran anything while a result
  // from the tab we DID drive is sitting there — prefer that over nothing.
  if (!entry && typeof lastRunTabId === 'number') { entry = all[String(lastRunTabId)]; id = lastRunTabId; }
  if (!entry || !entry.done) return;
  if (panelReplayedAt.get(port) === entry.savedAt) return;
  panelReplayedAt.set(port, entry.savedAt);
  try {
    port.postMessage({
      ...entry.done,
      kind: 'done',
      restored: true,
      task: entry.task,
      bundle: entry.bundle || null,
      tabId: id,
    });
  } catch { /* port closed under us */ }
}

// SW cold-start check (runs once per SW init, including a restart after
// eviction): a leftover checkpoint means the run it named never completed.
(async () => {
  const leftover = await sessionGet(LITE_RUN_CHECKPOINT_KEY);
  if (leftover && typeof leftover === 'object' && typeof leftover.runId === 'string') {
    orphanedRun = leftover;
    log('orphaned lite run found on SW cold start (evicted mid-run):', leftover.runId);
    await sessionRemove(LITE_RUN_CHECKPOINT_KEY);
  }
})();

async function runLiteFromPanel(port, msg) {
  if (liteBusy) { port.postMessage({ kind: 'error', message: 'a run is already in progress' }); return; }
  const tabId = msg.tabId;
  if (typeof tabId !== 'number') {
    port.postMessage({ kind: 'error', message: 'lite mode needs the current tab — open the panel on the page you want to test' });
    return;
  }
  const settings = await getSettings();
  const keys = await getKeys();
  const secrets = await getTestSecrets();
  // A4: both model roles need a key here (no desktop helper to sign in for us).
  // The panel turns `code: 'no-key'` into an "Open Settings" button, so the text
  // itself stays plain and says nothing about roles or storage.
  const NO_KEY_MESSAGE = 'No AI key saved yet. Open Settings and paste a key from Anthropic, Google or OpenAI.';
  // The model that plans: required unless its provider needs none (e.g. ollama).
  const brainProvider = settings.planner.provider;
  const brainKeyName = LITE_KEY_NAME[brainProvider];
  if (brainKeyName && !keys[brainKeyName]) {
    port.postMessage({ kind: 'error', code: 'no-key', message: NO_KEY_MESSAGE });
    return;
  }
  // The model that clicks: required unless it runs on this device / locally.
  const navProvider = settings.navigator.provider;
  const navKeyName = LITE_KEY_NAME[navProvider];
  if (navProvider !== 'nano' && navProvider !== 'ollama' && navKeyName && !keys[navKeyName]) {
    port.postMessage({ kind: 'error', code: 'no-key', message: NO_KEY_MESSAGE });
    return;
  }
  liteBusy = true;
  liteAbort = new AbortController();
  liteAbortReason = null;
  lastRunTabId = tabId;
  lastRunTask = typeof msg.task === 'string' ? msg.task : '';
  await forgetRunResult(tabId); // A10: the previous verdict for this tab is now stale
  // A22: this run supersedes whatever orphan report (if any) was left from a
  // prior SW life — starting fresh work is the natural "acknowledged" point.
  orphanedRun = null;
  const checkpointRunId = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await sessionSet({ [LITE_RUN_CHECKPOINT_KEY]: { runId: checkpointRunId, startedAt: Date.now(), task: msg.task } });
  port.postMessage({ kind: 'accepted' });
  try {
    await attachDebugger(tabId);
    const allowedHosts = ['localhost', '127.0.0.1'];
    if (typeof msg.allowHost === 'string' && msg.allowHost) allowedHosts.push(msg.allowHost);
    const result = await runLite({
      task: msg.task,
      url: msg.url,
      allowedHosts,
      keys,
      secrets,                         // A5: the saved test login, if any
      planner: settings.planner,       // BRAIN role
      navigator: settings.navigator,   // NAVIGATOR role
      browserDeps: makeLiteBrowserDeps(tabId),
      nanoDeps: liteNanoDeps,
      // A1 (P0): the panel's per-site "Allow the agent to click & type" checkbox
      // is the look-only switch — it decides THIS run. Absent (older panel) →
      // fall back to the stored setting.
      readOnly: typeof msg.readOnly === 'boolean' ? msg.readOnly : settings.readOnly,
      spendCapUsd: settings.spendCapUsd,  // safety: abort if estimated paid spend exceeds this
      strictOracles: settings.strictOracles, // A1: deterministic verdicts, safe-by-default ON
      onProgress: (line) => broadcastToPanels({ kind: 'progress', line }),
      onStep: (info) => broadcastToPanels({ kind: 'step', ...info }),
      signal: liteAbort.signal,
    });
    // A23: the engine returns a normal (not thrown) result even when its
    // signal was aborted mid-run — it just stamps a generic "cancelled by
    // user" reason. If OUR abort fired because the debugger detached, prefer
    // that clear message over the generic result.
    if (liteAbortReason) {
      broadcastToPanels({ kind: 'error', message: liteAbortReason });
    } else {
      lastLiteBundle = result.bundle;
      // A10: save before we broadcast — a panel that IS open re-reads the
      // "recent tests" list on this message, and a panel that isn't gets the
      // whole thing replayed when it comes back.
      await rememberRunResult(tabId, result.done, { task: msg.task, bundle: result.bundle });
      broadcastToPanels({ kind: 'done', ...result.done });
    }
  } catch (e) {
    broadcastToPanels({ kind: 'error', message: liteAbortReason || String(e && e.message ? e.message : e) });
  } finally {
    sendOverlayEnd(tabId);
    liteBusy = false;
    liteAbort = null;
    liteAbortReason = null;
    await sessionRemove(LITE_RUN_CHECKPOINT_KEY); // A22: run ended (pass/fail) — nothing to orphan
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'vibe-panel') return;
  panelPorts.add(port);
  // A10: a panel opening (or reopening) gets the last finished result straight
  // away, so closing it mid-test no longer throws the verdict away.
  void replayLastResult(port, null);

  port.onMessage.addListener(async (msg) => {
    if (!msg || typeof msg.kind !== 'string') return;
    try {
      switch (msg.kind) {
        case 'run': {
          // A4: an outdated (protocol-incompatible) daemon is treated like no
          // daemon at all — fall back to lite mode (BYOK, in-SW) rather than
          // forwarding to a pro-mode path that might silently misbehave.
          if (!bridgeHealthy()) { await runLiteFromPanel(port, msg); break; }
          try {
            // The panel targets the user's CURRENT tab (tabId/url from
            // chrome.tabs.query). Remember it so the overlay end signal lands there.
            if (msg.tabId !== undefined && msg.tabId !== null) lastRunTabId = msg.tabId;
            lastRunTask = typeof msg.task === 'string' ? msg.task : '';
            await forgetRunResult(lastRunTabId); // A10: previous verdict for this tab is stale
            // allowHost (panel consent toggle) is optional — forward it only when
            // present so old daemons / look-only runs are unaffected.
            const runParams = { task: msg.task, tabId: msg.tabId, url: msg.url };
            if (typeof msg.allowHost === 'string' && msg.allowHost) runParams.allowHost = msg.allowHost;
            // A1 (P0): the same checkbox decides look-only mode for THIS run —
            // forwarded explicitly so the stored setting never overrides what the
            // user just ticked. Omitted by older panels → the helper falls back
            // to its stored setting, as before.
            if (typeof msg.readOnly === 'boolean') runParams.readOnly = msg.readOnly;
            const result = await sendRequest('vibe.run', runParams);
            port.postMessage({ kind: 'accepted', ...(result || {}) });
          } catch (e) {
            port.postMessage({ kind: 'error', message: String(e && e.message ? e.message : e) });
          }
          break;
        }
        case 'cancel': {
          if (!daemonConnected()) {
            const was = !!liteAbort;
            if (liteAbort) liteAbort.abort();
            port.postMessage({ kind: 'cancelled', cancelled: was });
            break;
          }
          try {
            const result = await sendRequest('vibe.cancel', {});
            // {cancelled: boolean}. Old daemons answer 'unknown method …' → surfaced below.
            port.postMessage({ kind: 'cancelled', cancelled: !!(result && result.cancelled) });
          } catch (e) {
            port.postMessage({ kind: 'error', message: String(e && e.message ? e.message : e) });
          }
          break;
        }
        case 'fix': {
          if (!daemonConnected()) {
            port.postMessage({ kind: 'fix-done', ok: false, message: 'auto-fix needs Spike Core — copy the fix prompt and paste it into your coding agent.' });
            break;
          }
          try {
            // {accepted:true} on success; fix-progress / fix-done stream as vibe.*
            // events handled by the generic fan-out in handleBridgeEvent.
            // A11: the first fix for a project comes back as
            // {needsConfirmation:true, projectDir} instead — Spike Core has no
            // terminal to ask in, so the panel shows the confirm dialog and
            // re-sends this with confirmed:true.
            const result = await sendRequest('vibe.fix', msg && msg.confirmed ? { confirmed: true } : {});
            if (result && result.needsConfirmation) {
              port.postMessage({ kind: 'fix-confirm', projectDir: (result && result.projectDir) || '' });
              break;
            }
            // A11: no project folder chosen yet — surface it as a plain failure
            // so the panel's usual error banner points at Settings.
            if (result && result.needsProjectFolder) {
              port.postMessage({ kind: 'fix-done', ok: false, message: result.message || 'Set your project folder in Settings first.' });
              break;
            }
            // no panel message on accept; the daemon's fix-progress/fix-done drive UI
          } catch (e) {
            // includes 'unknown method vibe.fix' from an old daemon
            port.postMessage({ kind: 'fix-done', ok: false, message: String(e && e.message ? e.message : e) });
          }
          break;
        }
        case 'clip': {
          if (!daemonConnected()) {
            port.postMessage({ kind: 'clip-error', message: 'replay clips need Spike Core (lite mode is test-only).' });
            break;
          }
          try {
            // {name, mime, dataBase64} of the last saved replay clip.
            const result = await sendRequest('vibe.clip', {});
            port.postMessage({
              kind: 'clip',
              name: result && result.name,
              mime: result && result.mime,
              dataBase64: result && result.dataBase64,
            });
          } catch (e) {
            port.postMessage({ kind: 'clip-error', message: String(e && e.message ? e.message : e) });
          }
          break;
        }
        // A7: "Paste a document" mode — ONE planning call turns the pasted
        // document into a list of flows the panel shows as a checklist. No
        // browser work happens here, so it is safe to answer while idle or not.
        case 'decompose': {
          const spec = typeof msg.spec === 'string' ? msg.spec : '';
          const url = typeof msg.url === 'string' ? msg.url : undefined;
          if (daemonConnected()) {
            try {
              const r = await sendRequest('vibe.spec.decompose', { spec, url });
              const flows = (r && Array.isArray(r.flows)) ? r.flows : [];
              port.postMessage({ kind: 'flows', flows, truncated: false, total: flows.length });
            } catch (e) {
              port.postMessage({ kind: 'flows-error', message: String(e && e.message ? e.message : e) });
            }
            break;
          }
          // No desktop helper: plan the flows right here with the saved key,
          // and keep the list short (see LITE_MAX_FLOWS) because every flow is
          // a whole extra run paid for out of that key.
          try {
            const settings = await getSettings();
            const keys = await getKeys();
            const r = await decomposeSpecLite({
              spec,
              keys,
              planner: settings.planner,
              navigator: settings.navigator,
              url,
              maxFlows: LITE_MAX_FLOWS,
            });
            port.postMessage({
              kind: 'flows',
              flows: r.flows,
              truncated: r.truncated,
              total: r.total,
              cap: r.cap,
            });
          } catch (e) {
            port.postMessage({ kind: 'flows-error', message: String(e && e.message ? e.message : e) });
          }
          break;
        }
        case 'nano-download': {
          await handleNanoDownload();
          break;
        }
        case 'map-get': {
          // A51: read-only discovery-layer summary for the panel's "Site map"
          // card. No lite-mode fallback — the .spike/app-model.json ledger
          // lives next to wherever `spike daemon`/`spike map` run, which lite
          // mode (no daemon) has no access to; report simply "not present".
          if (!daemonConnected()) { port.postMessage({ kind: 'map', present: false }); break; }
          try {
            const result = await sendRequest('vibe.map.get', { host: msg.host });
            port.postMessage({ kind: 'map', ...(result || { present: false }) });
          } catch (e) {
            port.postMessage({ kind: 'map', present: false, error: String(e && e.message ? e.message : e) });
          }
          break;
        }
        case 'coverage-get': {
          // Same daemon-only contract as 'map-get' above.
          if (!daemonConnected()) { port.postMessage({ kind: 'coverage', present: false }); break; }
          try {
            const result = await sendRequest('vibe.coverage.get', { host: msg.host });
            port.postMessage({ kind: 'coverage', ...(result || { present: false }) });
          } catch (e) {
            port.postMessage({ kind: 'coverage', present: false, error: String(e && e.message ? e.message : e) });
          }
          break;
        }
        case 'status': {
          // A10: a status request is also the panel saying "catch me up" — if a
          // run finished while it was closed, replay that result now.
          void replayLastResult(port, typeof msg.tabId === 'number' ? msg.tabId : null);
          // A22: surface a leftover checkpoint from a run the SW never got to
          // finish (evicted/crashed mid-run) so the panel can tell the user
          // rather than staying silent about it.
          if (!daemonConnected()) { port.postMessage({ kind: 'status', busy: liteBusy, orphanedRun }); break; }
          try {
            const result = await sendRequest('vibe.status', {});
            port.postMessage({ kind: 'status', busy: !!(result && result.busy), orphanedRun });
          } catch (e) {
            port.postMessage({ kind: 'status', busy: false, error: String(e && e.message ? e.message : e), orphanedRun });
          }
          break;
        }
        case 'nano': {
          try {
            const availability = await nanoAvail();
            port.postMessage({ kind: 'nano', availability });
          } catch (e) {
            port.postMessage({ kind: 'nano', availability: 'unavailable', error: String(e && e.message ? e.message : e) });
          }
          break;
        }
        case 'bridge-status': {
          port.postMessage(bridgeStatusPayload());
          break;
        }
        case 'config-get': {
          if (!daemonConnected()) {
            port.postMessage({ kind: 'config', ...buildLiteConfig(await getKeys(), await getSettings(), await getTestSecrets()) });
            break;
          }
          try {
            const r = await sendRequest('vibe.config.get', {});
            port.postMessage({ kind: 'config', ...(r || {}) });
          } catch (e) {
            port.postMessage({ kind: 'error', message: String(e && e.message ? e.message : e) });
          }
          break;
        }
        case 'config-set': {
          if (!daemonConnected()) {
            await liteSetSettings(msg);
            port.postMessage({ kind: 'config', ...buildLiteConfig(await getKeys(), await getSettings(), await getTestSecrets()) });
            break;
          }
          try {
            await sendRequest('vibe.config.set', msg);
            // re-fetch the full config so providers/hasKey/defaults refresh
            const full = await sendRequest('vibe.config.get', {});
            port.postMessage({ kind: 'config', ...(full || {}) });
          } catch (e) {
            port.postMessage({ kind: 'error', message: String(e && e.message ? e.message : e) });
          }
          break;
        }
        case 'set-key': {
          if (!daemonConnected()) {
            try { await liteSetKey(msg.provider, msg.key); port.postMessage({ kind: 'key-saved', provider: msg.provider, ok: true }); }
            catch (e) { port.postMessage({ kind: 'key-saved', provider: msg.provider, ok: false, message: String(e && e.message ? e.message : e) }); }
            break;
          }
          try {
            await sendRequest('vibe.key.set', { provider: msg.provider, key: msg.key });
            port.postMessage({ kind: 'key-saved', provider: msg.provider, ok: true });
          } catch (e) {
            port.postMessage({ kind: 'key-saved', provider: msg.provider, ok: false, message: String(e && e.message ? e.message : e) });
          }
          break;
        }
        case 'clear-key': {
          if (!daemonConnected()) {
            try { const cleared = await liteClearKey(msg.provider); port.postMessage({ kind: 'key-saved', provider: msg.provider, ok: true, cleared }); }
            catch (e) { port.postMessage({ kind: 'key-saved', provider: msg.provider, ok: false, message: String(e && e.message ? e.message : e) }); }
            break;
          }
          try {
            await sendRequest('vibe.key.clear', { provider: msg.provider });
            port.postMessage({ kind: 'key-saved', provider: msg.provider, ok: true, cleared: true });
          } catch (e) {
            port.postMessage({ kind: 'key-saved', provider: msg.provider, ok: false, message: String(e && e.message ? e.message : e) });
          }
          break;
        }
        // A5: store / forget one test-login field. Goes to the desktop helper's
        // encrypted store when it is connected, otherwise to this browser's own
        // storage. Values are never echoed back — only whether one is saved.
        case 'set-secret': {
          if (!daemonConnected()) {
            try { await liteSetTestSecret(msg.name, msg.value); port.postMessage({ kind: 'secret-saved', name: msg.name, ok: true }); }
            catch (e) { port.postMessage({ kind: 'secret-saved', name: msg.name, ok: false, message: String(e && e.message ? e.message : e) }); }
            break;
          }
          try {
            await sendRequest('vibe.secret.set', { name: msg.name, value: msg.value });
            port.postMessage({ kind: 'secret-saved', name: msg.name, ok: true });
          } catch (e) {
            port.postMessage({ kind: 'secret-saved', name: msg.name, ok: false, message: String(e && e.message ? e.message : e) });
          }
          break;
        }
        case 'clear-secret': {
          if (!daemonConnected()) {
            try { const cleared = await liteClearTestSecret(msg.name); port.postMessage({ kind: 'secret-saved', name: msg.name, ok: true, cleared }); }
            catch (e) { port.postMessage({ kind: 'secret-saved', name: msg.name, ok: false, message: String(e && e.message ? e.message : e) }); }
            break;
          }
          try {
            const r = await sendRequest('vibe.secret.clear', { name: msg.name });
            port.postMessage({ kind: 'secret-saved', name: msg.name, ok: true, cleared: !!(r && r.cleared) });
          } catch (e) {
            port.postMessage({ kind: 'secret-saved', name: msg.name, ok: false, message: String(e && e.message ? e.message : e) });
          }
          break;
        }
        default:
          break;
      }
    } catch {
      /* never let a panel message crash the listener */
    }
  });

  port.onDisconnect.addListener(() => {
    panelPorts.delete(port);
  });
});

// ---- method handlers -------------------------------------------------------

// A7: schemes chrome.debugger CAN attach to but that we refuse anyway — other
// extensions' pages (which may be password managers etc.), devtools itself,
// and view-source. chrome.debugger already blocks chrome:// on its own, but
// we log + gate explicitly rather than rely on that alone. 'about:blank' (the
// tab ext.createTab makes for a fresh test tab) is allowed — only OTHER
// about: pages are refused.
const SENSITIVE_SCHEMES = ['chrome:', 'chrome-extension:', 'devtools:', 'edge:', 'view-source:', 'about:'];

async function attachDebugger(tabId) {
  if (attached.has(tabId)) return;
  // activeTab-narrowed build (A15 store-rejection fallback, no <all_urls>):
  // chrome.debugger.attach only has standing permission on the tab the user
  // just explicitly engaged (the panel's own active tab, tracked in
  // lastRunTabId — set from msg.tabId on every 'run' request BEFORE this is
  // called). Refuse anything else — a freshly-created tab (ext.createTab) or
  // an arbitrary daemon-supplied tabId (ext.attachTab) has no such grant.
  if (MANIFEST_VARIANT === 'activetab' && tabId !== lastRunTabId) {
    throw new Error(
      `attachDebugger: activeTab-narrowed build refuses to attach to tab ${tabId} — ` +
        `only the user-invoked current tab (${lastRunTabId}) is permitted without <all_urls>`,
    );
  }
  let url = '';
  try {
    url = (await getTab(tabId)).url || '';
  } catch { /* tab lookup failed — attach() below will fail with its own error */ }
  let scheme = '';
  try { scheme = new URL(url).protocol; } catch { /* opaque/new-tab urls */ }
  log('attaching debugger to tab', tabId, url || '(unknown url)');
  if (url !== 'about:blank' && SENSITIVE_SCHEMES.includes(scheme)) {
    throw new Error(`attachDebugger: refusing to attach to a ${scheme} page (tab ${tabId})`);
  }
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, DEBUGGER_VERSION, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
  attached.add(tabId);
}

async function detachDebugger(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  await new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      void chrome.runtime.lastError; // ignore — tab may already be gone
      resolve();
    });
  });
}

function createTab(url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url, active: true }, (tab) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(tab);
    });
  });
}

function navigateTab(tabId, url) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      fn(arg);
    };
    const onUpdated = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === 'complete') finish(resolve);
    };
    const timer = setTimeout(
      () => finish(reject, new Error(`navigate to ${url} timed out`)),
      NAVIGATE_TIMEOUT_MS,
    );
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.update(tabId, { url }, () => {
      if (chrome.runtime.lastError) finish(reject, new Error(chrome.runtime.lastError.message));
    });
  });
}

function getTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(tab);
    });
  });
}

function removeTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.remove(tabId, () => {
      void chrome.runtime.lastError; // ignore — tab may already be gone
      resolve();
    });
  });
}

function sendCdp(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(result);
    });
  });
}

// ---- Gemini Nano (Prompt API) ----------------------------------------------
//
// The web-exposed LanguageModel API runs Gemini Nano on-device. It may or may
// not be reachable from the MV3 service-worker global; if it is, we use it
// directly (no offscreen document, lower latency). If it is NOT, we host the
// session in an offscreen document (a real DOM document, which does qualify for
// the gemini-nano gate) and relay over chrome.runtime messaging.
//
// Semantics (MODEL_OPTS, VERDICT_SCHEMA, prompt text, fresh-session-per-verdict,
// warm-priming) mirror src/ports/runner-assets.ts and nano-offscreen.js exactly.

const NANO_MODEL_OPTS = {
  expectedInputs: [{ type: 'text', languages: ['en'] }, { type: 'image' }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};
const NANO_VERDICT_SCHEMA = {
  type: 'object',
  required: ['verdict', 'summary', 'issues'],
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail', 'uncertain'] },
    summary: { type: 'string' },
    issues: { type: 'array', items: { type: 'string' } },
  },
};
const OFFSCREEN_URL = 'nano-offscreen.html';

let nanoWarmSession = null; // used only when LanguageModel lives in the SW
let offscreenReady = null;

/** Reject a hung promise after ms — bridge requests must always get an answer. */
function withSwTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms in the extension`)), ms)),
  ]);
}

/** Is the web-exposed Prompt API reachable from this service worker? */
function nanoInSW() {
  return typeof LanguageModel !== 'undefined';
}

/** Ensure the offscreen document (which hosts the Nano session) exists. */
async function ensureOffscreen() {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    // hasDocument() is the modern probe; fall back to getContexts for older builds.
    let has = false;
    if (chrome.offscreen && chrome.offscreen.hasDocument) {
      has = await chrome.offscreen.hasDocument();
    } else if (chrome.runtime.getContexts) {
      const ctx = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
      });
      has = ctx.length > 0;
    }
    if (!has) {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ['BLOBS'], // we fetch() a data-URL into a Blob for the image input
        justification: 'Host the on-device Gemini Nano (Prompt API) session for QA verdicts.',
      });
    }
  })();
  try {
    await offscreenReady;
  } catch (e) {
    offscreenReady = null; // allow a retry on next call
    throw e;
  }
  return offscreenReady;
}

/** Send a nano op to the offscreen document and unwrap its response. */
async function callOffscreen(op, args) {
  await ensureOffscreen();
  const resp = await chrome.runtime.sendMessage({ target: 'nano-offscreen', op, args });
  if (!resp) throw new Error('no response from nano offscreen document');
  if (!resp.ok) throw new Error(resp.error || 'nano offscreen error');
  return resp.result;
}

async function nanoAvail() {
  if (nanoInSW()) return LanguageModel.availability(NANO_MODEL_OPTS);
  // If the offscreen path is unavailable too, that surfaces as 'api-missing'.
  if (!chrome.offscreen) return 'api-missing';
  return callOffscreen('avail');
}

async function nanoWarmup() {
  if (nanoInSW()) {
    if (!nanoWarmSession) {
      nanoWarmSession = await LanguageModel.create(NANO_MODEL_OPTS);
      await nanoWarmSession.prompt([{ role: 'user', content: [{ type: 'text', value: 'ok' }] }]);
    }
    return 'warm';
  }
  return callOffscreen('warmup');
}

/**
 * Kick off the Gemini Nano model download with PROGRESS broadcast to panels.
 *
 * Two paths mirror the rest of the nano plumbing:
 *  - SW-direct (LanguageModel reachable in the SW): create a session with a
 *    `monitor` that listens for 'downloadprogress' and broadcasts each update
 *    straight to panel ports as { kind:'nano-progress', status }.
 *  - Offscreen: ask the offscreen document to start the download; it
 *    chrome.runtime.sendMessage's progress to the SW, which rebroadcasts (see
 *    the chrome.runtime.onMessage listener below).
 * Either way, once the model is resident we re-probe availability and broadcast
 * the resulting { kind:'nano', availability } so the panel can flip to 'ready'.
 */
let nanoDownloadInFlight = false;
async function handleNanoDownload() {
  if (nanoDownloadInFlight) return;
  nanoDownloadInFlight = true;
  try {
    if (nanoInSW()) {
      broadcastToPanels({ kind: 'nano-progress', status: { state: 'starting' } });
      const session = await LanguageModel.create({
        ...NANO_MODEL_OPTS,
        monitor(m) {
          m.addEventListener('downloadprogress', (e) => {
            // e.loaded / e.total are bytes (0..1 fraction in some builds via e.loaded only)
            broadcastToPanels({
              kind: 'nano-progress',
              status: {
                loaded: typeof e.loaded === 'number' ? e.loaded : undefined,
                total: typeof e.total === 'number' ? e.total : undefined,
                progress: typeof e.loaded === 'number' && (e.total === undefined || e.total === 1)
                  ? e.loaded : undefined,
              },
            });
          });
        },
      });
      // prime + keep as the warm session so a subsequent verdict starts hot
      try {
        await session.prompt([{ role: 'user', content: [{ type: 'text', value: 'ok' }] }]);
        nanoWarmSession = session;
      } catch {
        try { session.destroy(); } catch { /* noop */ }
      }
    } else if (chrome.offscreen) {
      // offscreen path: it streams progress back via chrome.runtime.sendMessage
      broadcastToPanels({ kind: 'nano-progress', status: { state: 'starting' } });
      await callOffscreen('download');
    } else {
      broadcastToPanels({ kind: 'nano', availability: 'unavailable' });
      return;
    }
    // re-probe and tell the panel the final state (→ 'available' flips to ready)
    const availability = await nanoAvail();
    broadcastToPanels({ kind: 'nano', availability });
  } catch (e) {
    broadcastToPanels({ kind: 'nano-progress', status: { state: 'error', message: String(e && e.message ? e.message : e) } });
    try {
      const availability = await nanoAvail();
      broadcastToPanels({ kind: 'nano', availability });
    } catch { /* leave panel on last state */ }
  } finally {
    nanoDownloadInFlight = false;
  }
}

async function nanoVerdict(dataUrl, task) {
  if (nanoInSW()) {
    const blob = await (await fetch(dataUrl)).blob();
    const t0 = performance.now();
    const session = await LanguageModel.create(NANO_MODEL_OPTS);
    const raw = await session.prompt(
      [{
        role: 'user',
        content: [
          { type: 'text', value:
            'You are a QA assistant inspecting a screenshot of a web page.\n' +
            'Question: ' + task + '\n' +
            'Judge strictly from what is visible. List concrete issues if any.' },
          { type: 'image', value: blob },
        ],
      }],
      { responseConstraint: NANO_VERDICT_SCHEMA },
    );
    const ms = Math.round(performance.now() - t0);
    session.destroy();
    let v;
    try { v = JSON.parse(raw); }
    catch { v = { verdict: 'uncertain', summary: 'model returned non-JSON', issues: [String(raw).slice(0, 300)] }; }
    return { verdict: v, ms };
  }
  return callOffscreen('verdict', { dataUrl, task });
}

// NAVIGATOR step (Nano as the cheap per-step model): pick ONE action from the
// a11y text. Text-only (no image); mirrors runner-assets.ts navStep + the
// offscreen op. Rejects on non-JSON so the router falls to a cloud navigator.
async function nanoNavStep(prompt, schema) {
  if (nanoInSW()) {
    const session = await LanguageModel.create(NANO_MODEL_OPTS);
    const raw = await session.prompt(
      [{ role: 'user', content: [{ type: 'text', value: prompt }] }],
      { responseConstraint: schema },
    );
    session.destroy();
    return JSON.parse(raw);
  }
  return callOffscreen('navStep', { prompt, schema });
}

// Offscreen → SW: nano download progress. The offscreen document streams
// { target:'nano-progress', status } updates here; rebroadcast to panel ports.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'nano-progress') return false;
  broadcastToPanels({ kind: 'nano-progress', status: msg.status || {} });
  return false; // no response needed
});

// ---- replay recording (chrome.tabCapture → offscreen MediaRecorder → webm) --
//
// The offscreen document (the SAME one Nano uses — chrome.offscreen permits only
// one per extension) hosts the MediaRecorder. The SW's job here is:
//   rec.start {tabId} : mint a stream id with chrome.tabCapture.getMediaStreamId
//                       ({targetTabId:tabId}), ensure the offscreen doc, relay
//                       the streamId so the offscreen opens getUserMedia + starts
//                       MediaRecorder.
//   rec.stop {}       : tell the offscreen to stop, assemble the webm, base64 it,
//                       and return { webmBase64, bytes }.
//
// INVOCATION GATING: chrome.tabCapture.getMediaStreamId requires the extension to
// have been INVOKED on the tab (action click / activeTab-style gesture). The side
// panel does not cleanly count as an invocation, but with the "<all_urls>" host
// permission (which this extension holds) the product path generally succeeds.
// In a headless dev-loaded Chrome there is no gesture at all, so getMediaStreamId
// throws — we surface that as { ok:false, reason } and the run continues WITHOUT
// a clip. Recording must NEVER fail a run.

/** Promise wrapper for chrome.tabCapture.getMediaStreamId. */
function getMediaStreamId(targetTabId) {
  return new Promise((resolve, reject) => {
    try {
      if (!chrome.tabCapture || !chrome.tabCapture.getMediaStreamId) {
        reject(new Error('chrome.tabCapture.getMediaStreamId unavailable (missing "tabCapture" permission?)'));
        return;
      }
      chrome.tabCapture.getMediaStreamId({ targetTabId }, (streamId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!streamId) {
          reject(new Error('getMediaStreamId returned no streamId'));
        } else {
          resolve(streamId);
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

/** Begin recording the given tab. Resolves { ok, reason? }; never throws. */
async function recStart(tabId) {
  if (typeof tabId !== 'number') return { ok: false, reason: 'rec.start requires a numeric tabId' };
  if (!chrome.offscreen) return { ok: false, reason: 'chrome.offscreen unavailable — cannot host the recorder' };
  let streamId;
  try {
    streamId = await getMediaStreamId(tabId);
  } catch (e) {
    // The canonical invocation-gating failure lands here. Degrade gracefully.
    return {
      ok: false,
      reason: 'tabCapture not permitted (extension not invoked on this tab / no user gesture): ' +
        String(e && e.message ? e.message : e),
    };
  }
  try {
    await ensureOffscreen();
    const resp = await chrome.runtime.sendMessage({ target: 'nano-offscreen', op: 'rec.start', args: { streamId } });
    if (!resp) return { ok: false, reason: 'no response from recorder offscreen document' };
    return resp; // { ok:true, mime } | { ok:false, reason }
  } catch (e) {
    return { ok: false, reason: 'rec.start relay failed: ' + String(e && e.message ? e.message : e) };
  }
}

/** Stop recording and return the webm as base64. Resolves { ok, webmBase64?, bytes?, reason? }. */
async function recStop() {
  if (!chrome.offscreen) return { ok: false, reason: 'chrome.offscreen unavailable' };
  try {
    const resp = await chrome.runtime.sendMessage({ target: 'nano-offscreen', op: 'rec.stop', args: {} });
    if (!resp) return { ok: false, reason: 'no response from recorder offscreen document' };
    return resp; // { ok:true, webmBase64, bytes, mime } | { ok:false, reason }
  } catch (e) {
    return { ok: false, reason: 'rec.stop relay failed: ' + String(e && e.message ? e.message : e) };
  }
}

async function handleRequest(msg) {
  const { id, method, params = {} } = msg;
  try {
    let result;
    switch (method) {
      case 'ext.createTab': {
        const tab = await createTab(params.url || 'about:blank');
        await attachDebugger(tab.id);
        result = { tabId: tab.id };
        break;
      }
      case 'ext.attachTab': {
        // Attach to an EXISTING tab (vibe mode targets the user's current tab).
        // Never create a tab; just mark it attached so closeTab/keepTab applies.
        await attachDebugger(params.tabId);
        result = { tabId: params.tabId };
        break;
      }
      case 'ext.navigate': {
        await navigateTab(params.tabId, params.url);
        result = { ok: true };
        break;
      }
      case 'ext.closeTab': {
        // keepTab (attach-to-existing vibe runs): only detach the debugger so the
        // user's tab stays exactly where it is. Otherwise remove it (test path).
        await detachDebugger(params.tabId);
        if (!params.keepTab) await removeTab(params.tabId);
        result = { ok: true };
        break;
      }
      case 'ext.url': {
        const tab = await getTab(params.tabId);
        result = { url: tab.url || '' };
        break;
      }
      case 'cdp': {
        result = await sendCdp(params.tabId, params.method, params.params);
        break;
      }
      case 'nano.avail': {
        // never hang the bridge: offscreen-document creation can stall in some
        // environments (observed headless) — degrade to 'unavailable' so the
        // daemon's model ladder falls to rung 1 instead of timing out the run
        result = await Promise.race([
          nanoAvail(),
          new Promise((resolve) => setTimeout(() => resolve('unavailable'), 10_000)),
        ]);
        break;
      }
      case 'nano.warmup': {
        result = await withSwTimeout(nanoWarmup(), 120_000, 'nano.warmup');
        break;
      }
      case 'nano.verdict': {
        result = await withSwTimeout(nanoVerdict(params.dataUrl, params.task), 5 * 60_000, 'nano.verdict');
        break;
      }
      case 'nano.navStep': {
        result = await withSwTimeout(nanoNavStep(params.prompt, params.schema), 2 * 60_000, 'nano.navStep');
        break;
      }
      case 'rec.start': {
        // recStart already swallows its own errors into { ok:false, reason };
        // wrap in a timeout so a hung getUserMedia can't pin the bridge call.
        result = await Promise.race([
          recStart(params.tabId),
          new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason: 'rec.start timed out in the extension' }), 15_000)),
        ]);
        break;
      }
      case 'rec.stop': {
        // Generous: assembling + base64-ing a multi-MB webm takes a moment.
        result = await Promise.race([
          recStop(),
          new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason: 'rec.stop timed out in the extension' }), 25_000)),
        ]);
        break;
      }
      default:
        throw new Error(`unknown method ${method}`);
    }
    respond(id, result);
  } catch (err) {
    respondError(id, err);
  }
}

// ---- chrome.debugger event forwarding --------------------------------------

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined) return;
  emit('cdp', { tabId: source.tabId, method, params: params || {} }); // daemon (no-op if no ws)
  // lite mode: fan CDP events out to in-SW subscribers (the lite engine's transport)
  for (const fn of localCdpListeners) {
    try { fn(source.tabId, method, params || {}); } catch { /* a bad handler must not drop the event */ }
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return;
  attached.delete(source.tabId);
  emit('detached', { tabId: source.tabId, reason }); // daemon path: VibeService (src/vibe/service.ts) aborts on this
  // A23 (lite path): a mid-run detach (e.g. the user dismissed Chrome's
  // "<ext> is debugging this browser" banner) kills the CDP connection the
  // lite engine is driving over — abort now with a clear reason instead of
  // letting every subsequent chrome.debugger call fail with an opaque error.
  if (liteAbort && !liteAbort.signal.aborted && source.tabId === lastRunTabId) {
    liteAbortReason = "Chrome's debugging session was closed";
    liteAbort.abort(liteAbortReason);
  }
});

// ---- WebSocket connection / reconnect loop ---------------------------------

function connect() {
  if (connecting || (ws && ws.readyState === WebSocket.OPEN)) return;
  connecting = true;
  const url = `ws://localhost:${bridgePorts[bridgePortIdx % bridgePorts.length]}/`;
  bridgePortIdx = (bridgePortIdx + 1) % bridgePorts.length; // next attempt tries the next port
  let socket;
  try {
    socket = new WebSocket(url);
  } catch (e) {
    connecting = false;
    scheduleReconnect();
    return;
  }
  ws = socket;

  socket.addEventListener('open', async () => {
    connecting = false;
    reconnectDelay = 500;
    log('connected to bridge', socket.url);
    // Fresh connection: the handshake starts over. Until the daemon acks (or
    // the timeout below fires), compatibility is unknown — bridge-status
    // reports it as connected-but-unresolved rather than claiming "healthy".
    daemonProtocolVersion = null;
    daemonCompatible = null;
    if (handshakeTimer) clearTimeout(handshakeTimer);
    handshakeTimer = setTimeout(() => {
      handshakeTimer = null;
      if (daemonProtocolVersion !== null) return; // already acked
      // No ack within the window: a daemon that predates the handshake (or a
      // very slow one). Don't show "connected & healthy" without proof.
      daemonCompatible = false;
      broadcastToPanels(bridgeStatusPayload());
    }, HANDSHAKE_TIMEOUT_MS);
    // `caps` advertises this SW's supported methods so a bridge can disambiguate
    // when more than one SW (e.g. a stale install in another Chrome) dials in.
    // `protocolVersion` is this build's wire-protocol version (A4 handshake).
    // `token` is the A2 pairing token — the bridge closes the socket without it.
    const token = pairingToken ?? (await pairingTokenReady);
    emit('hello', { extension: chrome.runtime.id, caps: ['ext.attachTab', 'keepTab'], protocolVersion: PROTOCOL_VERSION, token });
  });

  socket.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    // daemon→ext request: { id, method, params? }
    if (typeof msg.id === 'number' && typeof msg.method === 'string') {
      handleRequest(msg);
      return;
    }
    // daemon→ext response to a panel-driven request: { rid, result|error }
    if (typeof msg.rid === 'number') {
      resolveRequest(msg);
      return;
    }
    // daemon→ext event: { event, params }
    if (typeof msg.event === 'string') {
      handleBridgeEvent(msg.event, msg.params);
      return;
    }
  });

  socket.addEventListener('close', () => {
    connecting = false;
    if (ws === socket) ws = null;
    if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null; }
    daemonProtocolVersion = null;
    daemonCompatible = null;
    scheduleReconnect();
  });

  socket.addEventListener('error', () => {
    // 'close' fires after 'error'; let scheduleReconnect run there.
    try { socket.close(); } catch { /* noop */ }
  });
}

function scheduleReconnect() {
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
  setTimeout(connect, delay);
}

// ---- keepalive (MV3 SW eviction) -------------------------------------------

chrome.alarms.create('qa-keepalive', { periodInMinutes: 0.25 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'qa-keepalive') return;
  // touching an API resets the idle timer; reconnect if we lost the socket
  if (!ws || ws.readyState !== WebSocket.OPEN) connect();
});

self.addEventListener('activate', () => connect());
chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());

// ---- side panel: open on toolbar action click ------------------------------
try {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((e) => log('setPanelBehavior failed', e));
  }
} catch (e) {
  log('sidePanel.setPanelBehavior unavailable', e);
}

log('service worker booted', new Date().toISOString());
connect();
