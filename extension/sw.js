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
 */

/* The daemon's bridge usually listens on 9410 (config default), but tests and
 * multi-instance setups bind nearby ports — the reconnect loop scans this small
 * candidate range round-robin, so no config has to reach the SW. */
const BRIDGE_PORT_CANDIDATES = [9410, 9411, 9412, 9413];
let bridgePortIdx = 0;
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
      case 'ext.navigate': {
        await navigateTab(params.tabId, params.url);
        result = { ok: true };
        break;
      }
      case 'ext.closeTab': {
        await detachDebugger(params.tabId);
        await removeTab(params.tabId);
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
        result = await nanoAvail();
        break;
      }
      case 'nano.warmup': {
        result = await nanoWarmup();
        break;
      }
      case 'nano.verdict': {
        result = await nanoVerdict(params.dataUrl, params.task);
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
  emit('cdp', { tabId: source.tabId, method, params: params || {} });
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
  const url = `ws://localhost:${BRIDGE_PORT_CANDIDATES[bridgePortIdx]}/`;
  bridgePortIdx = (bridgePortIdx + 1) % BRIDGE_PORT_CANDIDATES.length; // next attempt tries the next port
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
    emit('hello', { extension: chrome.runtime.id });
  });

  socket.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg && typeof msg.id === 'number' && typeof msg.method === 'string') {
      handleRequest(msg);
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

log('service worker booted', new Date().toISOString());
connect();
