/* v17 — pinpoint the vibe-run stall seen in v9 (progress stops after "run …",
 * no cursor events). Same wiring as v9 (headless ext Chrome + injected bridge),
 * but drives the engine pieces directly with per-phase logging + timeouts. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromeWithExtension } from '../src/chrome/extensions.js';
import { BridgeServer } from '../src/bridge/bridge-server.js';
import { openBrowserSession } from '../src/engine.js';
import { ExtensionNano } from '../src/ports/extension-nano.js';
import { loadConfig } from '../src/config.js';
import { startFixture, stopFixture } from '../fixture/server.js';

const CDP_PORT = 9338;
const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const cfg = loadConfig();

const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} TIMED OUT after ${ms}ms`)), ms))]);

const BRIDGE_PORT = 9419; // private — no other Chrome's SW scans this
const fixture = startFixture(cfg.fixturePort, true);
const bridge = new BridgeServer(BRIDGE_PORT);
let chrome: Awaited<ReturnType<typeof launchChromeWithExtension>>['chrome'] | null = null;

try {
  log('launching chrome+extension…');
  const launched = await launchChromeWithExtension({
    cdpPort: CDP_PORT,
    extensionDir: EXT_DIR,
    profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'qa-v17-')),
    headless: true,
    bridgePorts: [BRIDGE_PORT],
  });
  chrome = launched.chrome;
  await bridge.waitForExtension(30_000);
  log('bridge connected');

  log('openBrowserSession (extension, injected bridge)…');
  const session = await withTimeout(
    openBrowserSession({ via: 'extension', bridgePort: BRIDGE_PORT }, { bridge }),
    30_000,
    'openBrowserSession',
  );
  log('session open');

  log('ExtensionNano availability…');
  const nano = new ExtensionNano({ bridge });
  await nano.start();
  const avail = await withTimeout(nano.availability(), 15_000, 'nano.availability').catch((e) => `ERR: ${e.message}`);
  log(`nano availability: ${avail}`);

  log('navigate to fixture…');
  await withTimeout(session.browser.navigate(`http://localhost:${cfg.fixturePort}/login`), 35_000, 'navigate');
  log('navigated; url=' + (await withTimeout(session.browser.url(), 10_000, 'url')));

  log('axTree…');
  const ax = await withTimeout(session.browser.axTree(), 15_000, 'axTree');
  log(`axTree ok (${ax.text.split('\n').length} lines)`);

  log('screenshot…');
  const png = await withTimeout(session.browser.screenshot(), 15_000, 'screenshot');
  log(`screenshot ok (${png.length} bytes)`);

  log('planner availability probes…');
  const { GoogleCliAdapter } = await import('../src/router/adapters/google-cli.js');
  const { OllamaAdapter } = await import('../src/router/adapters/ollama.js');
  const cli = new GoogleCliAdapter({ bin: cfg.googleCliBin, model: cfg.googleCliModel, env: cfg.googleCliEnv });
  log(`google-cli available: ${await withTimeout(cli.available(), 20_000, 'gemini --version').catch((e) => `ERR ${e.message}`)}`);
  const ollama = new OllamaAdapter();
  log(`ollama available: ${await withTimeout(ollama.available(), 5_000, 'ollama probe').catch((e) => `ERR ${e.message}`)}`);

  log('ALL PHASES OK — the stall is elsewhere (likely the first planner CALL)');
  await session.close();
} catch (e) {
  log(`STALL FOUND → ${e instanceof Error ? e.message : e}`);
} finally {
  await bridge.close();
  await stopFixture(fixture);
  if (chrome) {
    try { chrome.kill(); } catch { /* gone */ }
  }
}
process.exit(0);
