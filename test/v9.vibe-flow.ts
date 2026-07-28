/* V9 — the vibe-mode quality gate, headless. Exercises the REAL loop the side
 * panel sits on top of:
 *
 *   BridgeServer + VibeService (what `spike daemon` runs)
 *     ⇅ ws://localhost:9410
 *   real MV3 extension SW (dev-loaded, simulating the user's Chrome)
 *     → vibe.run triggered from inside the SW exactly like the panel does
 *     ← vibe.progress / vibe.cursor / vibe.done events (hooked in the SW)
 *
 * Asserts on the bug-on fixture: run completes with verdict=fail, a non-empty
 * paste-ready fixPrompt + plain report, and ghost-cursor events flowed to the
 * tab. The panel DOM itself is covered by docs/vibe-panel-manual-test.md.
 * One AI run (~2-3 min on free quota). */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import CDP from 'chrome-remote-interface';
import { launchChromeWithExtension } from '../src/chrome/extensions.js';
import { BridgeServer } from '../src/bridge/bridge-server.js';
import { VibeService } from '../src/vibe/service.js';
import { loadConfig } from '../src/config.js';
import { sleep } from '../src/chrome/launch.js';
import { startFixture, stopFixture } from '../fixture/server.js';

const CDP_PORT = 9330; // simulated user Chrome
const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const cfg = loadConfig();
const TASK =
  'Log in as test@test.com with password pw, add the Widget to the cart, go to the cart, check out, and place the order. The order must end on a confirmation page.';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const BRIDGE_PORT = 9418; // private — other Chromes running this extension scan 9410-9413 and must not steal our socket
const fixture = startFixture(cfg.fixturePort, true); // bug ON
const bridge = new BridgeServer(BRIDGE_PORT);
new VibeService(bridge).start();

let chrome: Awaited<ReturnType<typeof launchChromeWithExtension>>['chrome'] | null = null;

try {
  const launched = await launchChromeWithExtension({
    cdpPort: CDP_PORT,
    extensionDir: EXT_DIR,
    profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'qa-v9-')),
    headless: true,
    bridgePorts: [BRIDGE_PORT],
  });
  chrome = launched.chrome;
  await bridge.waitForExtension(30_000);
  check('extension SW connected to the daemon bridge', true);

  // attach to the SW context to (a) hook incoming daemon events, (b) trigger
  // vibe.run exactly the way the panel's port handler does
  let sw: { id: string } | undefined;
  for (let i = 0; i < 30 && !sw; i++) {
    const targets = await CDP.List({ port: CDP_PORT });
    sw = targets.find((t) => t.url === `chrome-extension://${launched.extensionId}/sw.js`);
    if (!sw) await sleep(300);
  }
  if (!sw) throw new Error('SW target not found');
  const swClient = await CDP({ port: CDP_PORT, target: sw.id });
  await swClient.Runtime.enable();
  const swEval = async <T>(expression: string): Promise<T> => {
    const { result, exceptionDetails } = await swClient.Runtime.evaluate({
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'sw eval failed');
    return result.value as T;
  };

  await swEval(`(() => {
    self.__vibeEvents = [];
    const orig = handleBridgeEvent;
    handleBridgeEvent = (event, params) => {
      self.__vibeEvents.push({ event, params });
      return orig(event, params);
    };
    return 'hooked';
  })()`);

  const accepted = await swEval<{ accepted?: boolean }>(
    `sendRequest('vibe.run', { task: ${JSON.stringify(TASK)}, url: ${JSON.stringify(`http://localhost:${cfg.fixturePort}/login`)} })`,
  );
  check('vibe.run accepted', accepted?.accepted === true);

  // second run while busy must be refused
  const busyError = await swEval<string>(
    `sendRequest('vibe.run', { task: 'x', url: 'http://localhost:${cfg.fixturePort}/login' }).then(() => 'no-error', (e) => String(e.message || e))`,
  );
  check('concurrent run refused', busyError.includes('already in progress'));

  // wait for vibe.done (the run takes ~2-3 min: planner steps on free quota)
  let done: { params: Record<string, unknown> } | undefined;
  const deadline = Date.now() + 8 * 60_000;
  while (Date.now() < deadline && !done) {
    await sleep(5_000);
    const events = await swEval<{ event: string; params: Record<string, unknown> }[]>('self.__vibeEvents');
    done = events.find((e) => e.event === 'vibe.done');
    const progress = events.filter((e) => e.event === 'vibe.progress').length;
    const cursor = events.filter((e) => e.event === 'vibe.cursor').length;
    process.stdout.write(`\r  events: ${events.length} (progress ${progress}, cursor ${cursor})   `);
    if (events.find((e) => e.event === 'vibe.error')) {
      console.log('\nvibe.error:', JSON.stringify(events.find((e) => e.event === 'vibe.error')));
      break;
    }
  }
  console.log('');

  const events = await swEval<{ event: string; params: Record<string, unknown> }[]>('self.__vibeEvents');
  check('vibe.progress events flowed', events.some((e) => e.event === 'vibe.progress'));
  check(
    'ghost-cursor events flowed (moves + clicks)',
    events.filter((e) => e.event === 'vibe.cursor' && e.params.kind === 'move').length >= 2 &&
      events.some((e) => e.event === 'vibe.cursor' && e.params.kind === 'click'),
  );
  check('vibe.done arrived', Boolean(done));
  if (done) {
    const p = done.params;
    console.log('verdict:', p.verdict, '| reason:', String(p.reason).slice(0, 120));
    check('verdict is fail (bug-on fixture)', p.verdict === 'fail');
    check('plain report present + friendly', typeof p.plainReport === 'string' && (p.plainReport as string).length > 50);
    check(
      'fix prompt is paste-ready (repro + error + root cause)',
      typeof p.fixPrompt === 'string' &&
        (p.fixPrompt as string).includes('Steps to reproduce') &&
        (p.fixPrompt as string).toLowerCase().includes('root cause'),
    );
    console.log('\n--- fixPrompt (first 600 chars) ---\n' + String(p.fixPrompt).slice(0, 600) + '\n---');
  }

  await swClient.close();
} catch (e) {
  console.error('V9 FAILED:', e instanceof Error ? e.message : e);
  check('ran without throwing', false);
} finally {
  await bridge.close();
  await stopFixture(fixture);
  if (chrome) {
    try { chrome.kill(); } catch { /* gone */ }
  }
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} vibe-flow checks passed`);
process.exit(failed.length ? 1 : 0);
