/* V14 — replay-clip GIF exporter (scripted, no AI).
 *
 * Spins the fixture, launches a throwaway HEADLESS Chrome on CDP 9332 with a
 * mkdtemp profile, drives raw CDP directly (the recorder needs the raw client,
 * which CdpBrowser doesn't expose): CDP.New a tab → connect → Page.enable, start
 * the clip recorder, navigate between 3 fixture pages with pauses (each page
 * change makes Chrome emit screencast frames), stop → assert the GIF exists, is
 * >5KB, and starts with the GIF8 magic bytes. Kills Chrome in finally.
 *
 * Isolated: CDP 9332, fixture from loadConfig (9401 default; 9406 on collision). */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import CDP from 'chrome-remote-interface';
import { ensureChrome, sleep } from '../src/chrome/launch.js';
import { loadConfig } from '../src/config.js';
import { startClipRecorder } from '../src/clip/screencast.js';
import { startFixture, stopFixture } from '../fixture/server.js';
import type { ArtifactStoreLike } from '../src/clip/screencast.js';

const CDP_PORT = 9332;
const cfg = loadConfig();

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

/** Bind a fixture server, retrying on the fallback port if the first is busy.
 * startFixture's listen() is async, so EADDRINUSE arrives as an 'error' event —
 * race listening against it. */
async function bindFixture(): Promise<{ server: ReturnType<typeof startFixture>; port: number }> {
  for (const port of [cfg.fixturePort, 9406]) {
    const server = startFixture(port, false);
    const ok = await new Promise<boolean>((resolve) => {
      const onErr = (e: NodeJS.ErrnoException) => {
        if (e.code !== 'EADDRINUSE') throw e;
        resolve(false);
      };
      server.once('error', onErr);
      server.once('listening', () => { server.removeListener('error', onErr); resolve(true); });
      // already-listening fast path (listen() may resolve before we attach)
      if (server.listening) { server.removeListener('error', onErr); resolve(true); }
    });
    if (ok) return { server, port };
    await stopFixture(server).catch(() => {});
  }
  throw new Error('no free fixture port (tried default + 9406)');
}

const { server: fixture, port: fxPort } = await bindFixture();
const base = `http://localhost:${fxPort}`;
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-v14-'));

// throwaway artifact dir so we don't pollute the repo's artifacts/.
const artDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-v14-art-'));
const artifacts: ArtifactStoreLike = { dir: artDir };

let client: CDP.Client | null = null;
let tabId: string | null = null;

async function nav(url: string): Promise<void> {
  const loaded = client!.Page.loadEventFired();
  await client!.Page.navigate({ url });
  await Promise.race([loaded, sleep(8000)]);
}

try {
  await ensureChrome({ port: CDP_PORT, profileDir, headless: true, windowSize: '900,700' });
  check('headless Chrome up on CDP 9332', true);

  const target = await CDP.New({ port: CDP_PORT, url: 'about:blank' });
  tabId = (target as { id?: string; targetId?: string }).id ?? (target as { targetId?: string }).targetId!;
  client = await CDP({ port: CDP_PORT, target: tabId });
  await client.Page.enable();

  // start on /login, THEN start recording, THEN move around so frames are emitted.
  await nav(`${base}/login`);
  const recorder = await startClipRecorder(client, artifacts, { maxFps: 2, maxWidth: 800 });
  check('clip recorder started', true);

  // page changes drive screencast frames; pauses > 1/maxFps so each is kept.
  await sleep(700);
  await nav(`${base}/products`);
  await sleep(700);
  await nav(`${base}/cart`);
  await sleep(700);
  await nav(`${base}/checkout`);
  await sleep(700);

  const gifPath = await recorder.stop();
  check('recorder.stop returned a path (≥2 frames)', typeof gifPath === 'string');

  if (gifPath) {
    const exists = fs.existsSync(gifPath);
    check('replay.gif exists on disk', exists);
    if (exists) {
      const buf = fs.readFileSync(gifPath);
      check('gif is >5KB', buf.length > 5 * 1024);
      const magic = buf.subarray(0, 4).toString('ascii');
      check("gif starts with magic bytes 'GIF8'", magic === 'GIF8');
      check('gif written as artifacts/<runId>/replay.gif', path.basename(gifPath) === 'replay.gif');
      console.log(`  gif: ${buf.length} bytes at ${gifPath}`);
    }
  }
} catch (e) {
  console.error('V14 FAILED:', e instanceof Error ? (e.stack ?? e.message) : e);
  check('ran without throwing', false);
} finally {
  if (client) {
    try { await client.close(); } catch { /* gone */ }
  }
  if (tabId) {
    try { await CDP.Close({ port: CDP_PORT, id: tabId }); } catch { /* gone */ }
  }
  await stopFixture(fixture);
  // kill the throwaway Chrome (spawned detached by ensureChrome): ask the
  // browser target itself to close — cleaner than process-tree killing.
  try {
    const browserClient = await CDP({ port: CDP_PORT });
    await browserClient.Browser.close().catch(() => {});
    await browserClient.close().catch(() => {});
  } catch { /* already gone */ }
  try { fs.rmSync(artDir, { recursive: true, force: true }); } catch { /* */ }
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* */ }
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v14 checks passed`);
process.exit(failed.length ? 1 : 0);
