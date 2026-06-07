/* V3/V4 verification — ExtensionBrowser passes the SAME port contract as
 * CdpBrowser (test/port-contract.ts: navigate/url, stable axTree ids,
 * click→logpoint with live values, network capture, type, screenshot,
 * per-step drains).
 *
 * Wiring: launchChromeWithExtension dev-loads the MV3 extension over the
 * CDP pipe (its sw.js dials out to the bridge on 9410); BridgeServer accepts;
 * ExtensionBrowser drives the tab through chrome.debugger — the engine-side
 * code paths (axtree/capture/logpoints) are byte-identical to CdpBrowser's. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromeWithExtension } from '../src/chrome/extensions.js';
import { BridgeServer, DEFAULT_BRIDGE_PORT } from '../src/bridge/bridge-server.js';
import { ExtensionBrowser } from '../src/ports/extension-browser.js';
import { runPortContract } from './port-contract.js';

const CDP_PORT = 9326; // throwaway, owned by launchChromeWithExtension
const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-v3-'));
const bridge = new BridgeServer(DEFAULT_BRIDGE_PORT);
let chrome: Awaited<ReturnType<typeof launchChromeWithExtension>>['chrome'] | null = null;

try {
  const launched = await launchChromeWithExtension({
    cdpPort: CDP_PORT,
    extensionDir: EXT_DIR,
    profileDir: profile,
    headless: true,
  });
  chrome = launched.chrome;
  console.log('loaded extension id:', launched.extensionId);

  const browser = new ExtensionBrowser({ bridge });
  const results = await runPortContract(browser, { label: 'ExtensionBrowser', httpPort: 9403 });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
} catch (e) {
  console.error('V3 FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
} finally {
  await bridge.close();
  if (chrome) {
    try { chrome.kill(); } catch { /* gone */ }
  }
}
