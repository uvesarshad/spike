/* ExtensionBrowser — deliberate stub. The vibe-mode milestone implements the
 * same BrowserPort contract from inside an MV3 extension, which is what makes
 * the product plug-and-play (Web Store install, no flags, real logged-in
 * sessions, native Prompt API access). Each TODO maps the op to its MV3
 * equivalent, mostly proven already in spikes/extension/panel.js. */

import type {
  AxSnapshot,
  BrowserPort,
  ConsoleEntry,
  LogpointSpec,
  NetworkEntry,
} from './browser-port.js';

const NOT_IMPLEMENTED = 'ExtensionBrowser: not implemented — MVP uses CdpBrowser';

export class ExtensionBrowser implements BrowserPort {
  // TODO: connect to the extension over a local WebSocket bridge (daemon side).
  async launch(): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  // TODO: chrome.tabs.update / chrome.tabs.create
  async navigate(_url: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  // TODO: chrome.tabs.get(tabId).url
  async url(): Promise<string> {
    throw new Error(NOT_IMPLEMENTED);
  }

  // TODO: chrome.debugger.sendCommand('Accessibility.getFullAXTree') — same
  // post-processing as capture/axtree.ts, shared once this lands.
  async axTree(): Promise<AxSnapshot> {
    throw new Error(NOT_IMPLEMENTED);
  }

  // TODO: chrome.debugger.sendCommand('Input.dispatchMouseEvent')
  async click(_nodeId: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  // TODO: chrome.debugger.sendCommand('Input.insertText')
  async type(_nodeId: string, _text: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  // TODO: chrome.tabs.captureVisibleTab (proven in spikes/extension/panel.js)
  async screenshot(): Promise<Buffer> {
    throw new Error(NOT_IMPLEMENTED);
  }

  // TODO: chrome.debugger.sendCommand('Debugger.setBreakpointByUrl', {condition})
  async setLogpoint(_spec: LogpointSpec): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  // TODO: chrome.debugger Runtime/Network events buffered in the service worker;
  // fallback: the injected fetch/onerror shim from spikes/cdp-logpoint/spike.js.
  drainConsole(): ConsoleEntry[] {
    throw new Error(NOT_IMPLEMENTED);
  }

  drainNetwork(): NetworkEntry[] {
    throw new Error(NOT_IMPLEMENTED);
  }

  async close(): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
