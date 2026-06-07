/* V6 verification — ExtensionNano reproduces spike A through the extension
 * bridge: availability, warm session, verdict discrimination on the spike's
 * good/bad screenshots (spikes/cdp-logpoint/shots/).
 *
 * Wiring: launchChromeWithExtension dev-loads the MV3 extension on CDP port 9327
 * using the spike profile (which already holds the ~2GB Nano model); its sw.js
 * dials out to the bridge on 9411; ExtensionNano relays nano.* over the bridge.
 *
 * Exits 0 only when it discriminates good=pass / bad=fail; exits 2 (skip) when
 * the model isn't 'available' so CI-ish runs don't hard-fail. Always kills the
 * Chrome it spawns. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromeWithExtension } from '../src/chrome/extensions.js';
import { BridgeServer } from '../src/bridge/bridge-server.js';
import { ExtensionNano } from '../src/ports/extension-nano.js';

const CDP_PORT = 9327; // throwaway, owned by launchChromeWithExtension
const BRIDGE_PORT = 9411; // distinct from the daemon default (9410) and other agents
const PROFILE = 'C:\\Users\\uvesk\\AppData\\Local\\qa-spike-chrome-profile';
const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, '..', 'spikes', 'cdp-logpoint', 'shots');
const TASK =
  'Does this page render correctly: a complete dashboard UI with visible navigation and content, no blank areas, no error messages, no obviously broken layout?';

for (const f of ['good.png', 'bad.png']) {
  if (!fs.existsSync(path.join(shots, f))) {
    console.error(`missing ${f} — run the spike capture first (spikes/cdp-logpoint/capture-shots.js)`);
    process.exit(2);
  }
}

const bridge = new BridgeServer(BRIDGE_PORT);
let chrome: Awaited<ReturnType<typeof launchChromeWithExtension>>['chrome'] | null = null;
let exitCode = 1;

try {
  const launched = await launchChromeWithExtension({
    cdpPort: CDP_PORT,
    extensionDir: EXT_DIR,
    profileDir: PROFILE,
    headless: false, // Nano availability is only proven headed
  });
  chrome = launched.chrome;
  console.log('loaded extension id:', launched.extensionId);

  const nano = new ExtensionNano({ bridge });
  await nano.start();
  console.log('extension connected to bridge on', BRIDGE_PORT);

  let a = await nano.availability();
  // a fresh Chrome re-validates the on-device model component for a while
  // ('downloading' even though it's on disk) — poll while Chrome stays up,
  // because killing Chrome restarts the validation from scratch
  for (let i = 0; i < 30 && (a === 'downloading' || a === 'downloadable'); i++) {
    await new Promise((r) => setTimeout(r, 5_000));
    a = await nano.availability();
    console.log(`availability (poll ${i + 1}):`, a);
    if (a === 'available') break;
  }
  console.log('availability:', a);
  if (a !== 'available') {
    console.error('model not available in extension mode — skipping (exit 2)');
    exitCode = 2;
  } else {
    console.log('warming up…');
    const t0 = Date.now();
    await nano.warmup();
    console.log(`warm in ${Date.now() - t0} ms`);

    const results: Record<string, string> = {};
    for (const page of ['good', 'bad'] as const) {
      const png = fs.readFileSync(path.join(shots, `${page}.png`));
      const { verdict, ms } = await nano.verdict(png, TASK);
      results[page] = verdict.verdict;
      console.log(`\n--- ${page}.png → ${verdict.verdict} (${ms} ms, $0.00 on-device) ---`);
      console.log(JSON.stringify(verdict, null, 2));
    }

    const ok = results.good === 'pass' && results.bad === 'fail';
    console.log(`\ndiscriminates good vs broken UI: ${ok ? 'PASS' : 'FAIL'}`);
    exitCode = ok ? 0 : 1;
  }

  await nano.close();
} catch (e) {
  console.error('V6 FAILED:', e instanceof Error ? e.stack : e);
  exitCode = 1;
} finally {
  await bridge.close();
  if (chrome) {
    try { chrome.kill(); } catch { /* gone */ }
  }
}

process.exit(exitCode);
