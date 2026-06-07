/* V1 probe — can this Chrome dev-load an unpacked MV3 extension WITHOUT
 * --load-extension (dead in branded Chrome 137+)?
 *
 * Mechanism (confirmed against Chrome 148): Extensions.loadUnpacked is exposed
 * ONLY over --remote-debugging-pipe + --enable-unsafe-extension-debugging — over
 * a port-based WebSocket it returns "Method not available." So we launch Chrome
 * with BOTH the pipe (for the one-shot load) and the port (for the daemon), do
 * the load over a tiny hand-rolled NUL-framed pipe client, then verify the
 * extension's service-worker target shows up in CDP.List on the PORT. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import CDP from 'chrome-remote-interface';
import { sleep } from '../src/chrome/launch.js';
import { launchChromeWithExtension } from '../src/chrome/extensions.js';

const CDP_PORT = 9325; // throwaway
const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-v1-'));

let chrome: import('node:child_process').ChildProcess | null = null;
const cleanup = () => {
  try { chrome?.kill(); } catch { /* gone */ }
};
process.on('exit', cleanup);

try {
  const res = await launchChromeWithExtension({
    cdpPort: CDP_PORT,
    extensionDir: EXT_DIR,
    profileDir: profile,
    // headed by default; headless also works — flip to true if you prefer
  });
  chrome = res.chrome;
  const id = res.extensionId;
  console.log('loaded unpacked extension, id:', id);

  const version = await CDP.Version({ port: CDP_PORT });
  console.log('chrome:', version.Browser);

  // verify the SW target exists over the PORT (what the rest of the daemon uses)
  let swFound = false;
  for (let i = 0; i < 30 && !swFound; i++) {
    const targets = await CDP.List({ port: CDP_PORT });
    swFound = targets.some((t) => t.url === `chrome-extension://${id}/sw.js`);
    if (!swFound) await sleep(300);
  }
  console.log(`service worker target found: ${swFound ? 'PASS' : 'FAIL'}`);
  process.exit(swFound ? 0 : 1);
} catch (e) {
  console.error('V1 PROBE FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
} finally {
  cleanup();
}
