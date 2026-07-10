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

import { runLite, buildLiteConfig, DEFAULT_SETTINGS } from './lite-engine.js';

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
const DEBUGGER_VERSION = '1.3';
const NAVIGATE_TIMEOUT_MS = 30_000;

let ws = null;
let reconnectDelay = 500; // backoff, capped below
let connecting = false;

/** tabIds we have an attached chrome.debugger session for. */
const attached = new Set();

function log(...args) {
  console.log('[qa-subagent:sw]', ...args);
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
      reject(new Error('daemon not running — start it with: qa daemon'));
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

/** Dispatch a daemon event frame { event, params }. */
function handleBridgeEvent(event, params) {
  if (event === 'vibe.cursor') {
    routeCursorToOverlay(params);
  }
  // Run finished (or failed): clear the page overlay on the run's tab.
  if (event === 'vibe.done' || event === 'vibe.error') {
    sendOverlayEnd(lastRunTabId);
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

function storageGet(key) {
  return new Promise((resolve) => chrome.storage.local.get(key, (v) => resolve(v && v[key])));
}
function storageSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, () => resolve()));
}
async function getKeys() {
  return (await storageGet('qaKeys')) || {};
}
async function getSettings() {
  const s = (await storageGet('qaSettings')) || {};
  return {
    planner: { ...DEFAULT_SETTINGS.planner, ...(s.planner || {}) },       // BRAIN role
    navigator: { ...DEFAULT_SETTINGS.navigator, ...(s.navigator || {}) }, // NAVIGATOR role
    debugMode: s.debugMode || DEFAULT_SETTINGS.debugMode,
    debugAgent: s.debugAgent || DEFAULT_SETTINGS.debugAgent,
    videoAssertions: Boolean(s.videoAssertions ?? DEFAULT_SETTINGS.videoAssertions),
  };
}
async function liteSetKey(provider, key) {
  const name = LITE_KEY_NAME[provider];
  if (!name) throw new Error(`provider ${provider} takes no key`);
  if (!key) throw new Error('a non-empty key is required');
  const keys = await getKeys();
  keys[name] = String(key);
  await storageSet({ qaKeys: keys });
}
async function liteClearKey(provider) {
  const name = LITE_KEY_NAME[provider];
  if (!name) throw new Error(`provider ${provider} takes no key`);
  const keys = await getKeys();
  const had = name in keys;
  delete keys[name];
  await storageSet({ qaKeys: keys });
  return had;
}
async function liteSetSettings(patch) {
  const cur = await getSettings();
  const next = {
    debugMode: patch.debugMode || cur.debugMode,
    debugAgent: patch.debugAgent || cur.debugAgent,
    videoAssertions:
      patch.videoAssertions !== undefined ? Boolean(patch.videoAssertions) : Boolean(cur.videoAssertions),
    planner: { ...cur.planner, ...(patch.planner || {}) },        // BRAIN role
    navigator: { ...cur.navigator, ...(patch.navigator || {}) },  // NAVIGATOR role
  };
  await storageSet({ qaSettings: next });
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
let lastLiteBundle = null; // for a future "download report" affordance

async function runLiteFromPanel(port, msg) {
  if (liteBusy) { port.postMessage({ kind: 'error', message: 'a run is already in progress' }); return; }
  const tabId = msg.tabId;
  if (typeof tabId !== 'number') {
    port.postMessage({ kind: 'error', message: 'lite mode needs the current tab — open the panel on the page you want to test' });
    return;
  }
  const settings = await getSettings();
  const keys = await getKeys();
  // Brain (planner) key: required unless its provider needs none (e.g. ollama).
  const brainProvider = settings.planner.provider;
  const brainKeyName = LITE_KEY_NAME[brainProvider];
  if (brainKeyName && !keys[brainKeyName]) {
    port.postMessage({ kind: 'error', message: `Add your Brain (planner) API key in Settings — no "${brainProvider}" key found (lite mode is BYOK; no daemon).` });
    return;
  }
  // Navigator key: required unless nano/ollama (they need no key).
  const navProvider = settings.navigator.provider;
  const navKeyName = LITE_KEY_NAME[navProvider];
  if (navProvider !== 'nano' && navProvider !== 'ollama' && navKeyName && !keys[navKeyName]) {
    port.postMessage({ kind: 'error', message: `Add your Navigator API key in Settings (or set Navigator to Nano) — no "${navProvider}" key found.` });
    return;
  }
  liteBusy = true;
  liteAbort = new AbortController();
  lastRunTabId = tabId;
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
      planner: settings.planner,       // BRAIN role
      navigator: settings.navigator,   // NAVIGATOR role
      browserDeps: makeLiteBrowserDeps(tabId),
      nanoDeps: liteNanoDeps,
      onProgress: (line) => broadcastToPanels({ kind: 'progress', line }),
      onStep: (info) => broadcastToPanels({ kind: 'step', ...info }),
      signal: liteAbort.signal,
    });
    lastLiteBundle = result.bundle;
    broadcastToPanels({ kind: 'done', ...result.done });
  } catch (e) {
    broadcastToPanels({ kind: 'error', message: String(e && e.message ? e.message : e) });
  } finally {
    sendOverlayEnd(tabId);
    liteBusy = false;
    liteAbort = null;
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'vibe-panel') return;
  panelPorts.add(port);

  port.onMessage.addListener(async (msg) => {
    if (!msg || typeof msg.kind !== 'string') return;
    try {
      switch (msg.kind) {
        case 'run': {
          if (!daemonConnected()) { await runLiteFromPanel(port, msg); break; }
          try {
            // The panel targets the user's CURRENT tab (tabId/url from
            // chrome.tabs.query). Remember it so the overlay end signal lands there.
            if (msg.tabId !== undefined && msg.tabId !== null) lastRunTabId = msg.tabId;
            // allowHost (panel consent toggle) is optional — forward it only when
            // present so old daemons / read-only runs are unaffected.
            const runParams = { task: msg.task, tabId: msg.tabId, url: msg.url };
            if (typeof msg.allowHost === 'string' && msg.allowHost) runParams.allowHost = msg.allowHost;
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
            port.postMessage({ kind: 'fix-done', ok: false, message: 'auto-fix needs the desktop app — copy the fix prompt and paste it into your coding agent.' });
            break;
          }
          try {
            // {accepted:true} on success; fix-progress / fix-done stream as vibe.*
            // events handled by the generic fan-out in handleBridgeEvent.
            await sendRequest('vibe.fix', {});
            // no panel message on accept; the daemon's fix-progress/fix-done drive UI
          } catch (e) {
            // includes 'unknown method vibe.fix' from an old daemon
            port.postMessage({ kind: 'fix-done', ok: false, message: String(e && e.message ? e.message : e) });
          }
          break;
        }
        case 'clip': {
          if (!daemonConnected()) {
            port.postMessage({ kind: 'clip-error', message: 'replay clips need the desktop app (lite mode is test-only).' });
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
        case 'nano-download': {
          await handleNanoDownload();
          break;
        }
        case 'status': {
          if (!daemonConnected()) { port.postMessage({ kind: 'status', busy: liteBusy }); break; }
          try {
            const result = await sendRequest('vibe.status', {});
            port.postMessage({ kind: 'status', busy: !!(result && result.busy) });
          } catch (e) {
            port.postMessage({ kind: 'status', busy: false, error: String(e && e.message ? e.message : e) });
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
          port.postMessage({ kind: 'bridge-status', connected: !!(ws && ws.readyState === WebSocket.OPEN) });
          break;
        }
        case 'config-get': {
          if (!daemonConnected()) {
            port.postMessage({ kind: 'config', ...buildLiteConfig(await getKeys(), await getSettings()) });
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
            port.postMessage({ kind: 'config', ...buildLiteConfig(await getKeys(), await getSettings()) });
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

async function attachDebugger(tabId) {
  if (attached.has(tabId)) return;
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
  emit('detached', { tabId: source.tabId, reason });
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

  socket.addEventListener('open', () => {
    connecting = false;
    reconnectDelay = 500;
    log('connected to bridge', socket.url);
    // `caps` advertises this SW's supported methods so a bridge can disambiguate
    // when more than one SW (e.g. a stale install in another Chrome) dials in.
    emit('hello', { extension: chrome.runtime.id, caps: ['ext.attachTab', 'keepTab'] });
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
