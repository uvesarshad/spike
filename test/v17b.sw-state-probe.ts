/* v17b — why doesn't the pinned SW dial the private bridge? Launch, pin, then
 * inspect the SW's live state (bridgePorts, ws, console). */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import CDP from 'chrome-remote-interface';
import { launchChromeWithExtension } from '../src/chrome/extensions.js';
import { BridgeServer } from '../src/bridge/bridge-server.js';
import { sleep } from '../src/chrome/launch.js';

const CDP_PORT = 9339;
const BRIDGE_PORT = 9419;
const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');

const bridge = new BridgeServer(BRIDGE_PORT);
let chrome: Awaited<ReturnType<typeof launchChromeWithExtension>>['chrome'] | null = null;

try {
  const launched = await launchChromeWithExtension({
    cdpPort: CDP_PORT,
    extensionDir: EXT_DIR,
    profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'qa-v17b-')),
    headless: true,
    bridgePorts: [BRIDGE_PORT],
  });
  chrome = launched.chrome;
  console.log('launched, ext id', launched.extensionId);

  const targets = await CDP.List({ port: CDP_PORT });
  const sw = targets.find((t) => t.url.endsWith('/sw.js'));
  if (!sw) throw new Error('no sw target');
  const c = await CDP({ port: CDP_PORT, target: sw.id });
  await c.Runtime.enable();

  for (let i = 0; i < 6; i++) {
    const { result } = await c.Runtime.evaluate({
      expression: `JSON.stringify({
        bridgePorts: typeof bridgePorts !== 'undefined' ? bridgePorts : 'UNDEF',
        idx: typeof bridgePortIdx !== 'undefined' ? bridgePortIdx : 'UNDEF',
        wsState: ws ? ws.readyState : 'null',
        wsUrl: ws ? ws.url : null,
        connecting,
        storage: await new Promise(r => chrome.storage.local.get('bridgePorts', v => r(v && v.bridgePorts)))
      })`,
      awaitPromise: true,
      returnByValue: true,
      replMode: true,
    });
    console.log(`[${i * 2}s]`, result.value);
    await sleep(2000);
  }
  await c.close();
} catch (e) {
  console.error('PROBE ERR:', e instanceof Error ? e.message : e);
} finally {
  await bridge.close();
  if (chrome) {
    try { chrome.kill(); } catch { /* gone */ }
  }
}
process.exit(0);
