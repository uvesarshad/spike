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

const BRIDGE_PORT = 9410;
const BRIDGE_URL = `ws://localhost:${BRIDGE_PORT}/`;
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
  let socket;
  try {
    socket = new WebSocket(BRIDGE_URL);
  } catch (e) {
    connecting = false;
    scheduleReconnect();
    return;
  }
  ws = socket;

  socket.addEventListener('open', () => {
    connecting = false;
    reconnectDelay = 500;
    log('connected to bridge', BRIDGE_URL);
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
