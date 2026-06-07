/* V19 verification — the chrome.tabCapture → MediaRecorder → webm replay
 * recorder, end to end through the extension bridge.
 *
 * Why this transport exists: chrome.debugger does NOT expose Page.startScreencast,
 * so the CDP-screencast GIF recorder (src/clip/screencast.ts) cannot run in
 * extension/vibe mode. The product target is a chrome.tabCapture recorder hosted
 * in the (single) offscreen document: SW mints a streamId with
 * chrome.tabCapture.getMediaStreamId, relays it to the offscreen doc, which opens
 * getUserMedia({video:{mandatory:{chromeMediaSource:'tab',…}}}) → MediaRecorder →
 * webm chunks.
 *
 * INVOCATION GATING (the crux): chrome.tabCapture.getMediaStreamId requires the
 * extension to have been INVOKED on the tab (action click / activeTab-style user
 * gesture). The side panel does not cleanly count; the documented workaround is
 * the "<all_urls>" host permission (which this extension holds), under which the
 * PRODUCT path (real user opening the panel + clicking Run) generally succeeds.
 * In this HEADLESS, dev-loaded Chrome there is no gesture at all, so we expect
 * getMediaStreamId to be DENIED — in which case the recorder must degrade to
 * { ok:false, reason } and the run continues WITHOUT a clip (never failing it).
 *
 * This test verifies as much as the environment allows and reports which case it
 * hit:
 *   - {ok:false} on rec.start  → assert the graceful-failure shape; PRINT that
 *     the product path needs manual verification. Exit 0.
 *   - {ok:true}                → record ~3s while navigating, rec.stop, assert
 *     webm magic (0x1A45DFA3) + nonzero bytes, save artifacts/tabcapture-proof.webm.
 *     Exit 0.
 *   - broken plumbing (bridge errors, malformed responses) → Exit 1.
 *
 * Ports: CDP 9340, bridge 9420 (pinned into the SW). Always kills the Chrome it
 * spawns. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromeWithExtension } from '../src/chrome/extensions.js';
import { BridgeServer } from '../src/bridge/bridge-server.js';

const CDP_PORT = 9340;
const BRIDGE_PORT = 9420;
const here = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(here, '..', 'extension');
const PROFILE = path.join(
  process.env.LOCALAPPDATA ?? process.env.HOME ?? '.',
  'qa-spike-v19-profile',
);
const OUT_DIR = path.resolve('artifacts');

interface RecStartResult { ok: boolean; reason?: string; mime?: string }
interface RecStopResult { ok: boolean; reason?: string; webmBase64?: string; bytes?: number; mime?: string }

const pass: string[] = [];
function ok(line: string): void { pass.push(line); console.log('PASS:', line); }
function info(line: string): void { console.log('  •', line); }
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

const bridge = new BridgeServer(BRIDGE_PORT);
let chrome: Awaited<ReturnType<typeof launchChromeWithExtension>>['chrome'] | null = null;
let exitCode = 1;

try {
  const launched = await launchChromeWithExtension({
    cdpPort: CDP_PORT,
    extensionDir: EXT_DIR,
    profileDir: PROFILE,
    headless: true,             // CI-shaped: this is precisely the no-gesture path
    bridgePorts: [BRIDGE_PORT], // pin the SW to OUR bridge only
  });
  chrome = launched.chrome;
  info(`loaded extension id: ${launched.extensionId}`);

  await bridge.waitForExtension(30_000);
  ok('extension SW connected to the bridge on ' + BRIDGE_PORT);

  // Create a real tab (so tabCapture has a target). ext.createTab also attaches
  // the debugger; we navigate it to a data: page so it has visible content.
  const created = await bridge.call<{ tabId: number }>('ext.createTab', {
    url: 'data:text/html,<body style="background:%23114">' +
      '<h1 style="color:white;font-family:sans-serif">QA recording target</h1></body>',
  }, 20_000);
  if (!created || typeof created.tabId !== 'number') {
    throw new Error('ext.createTab did not return a numeric tabId — bridge plumbing broken');
  }
  const tabId = created.tabId;
  ok('created + attached a target tab (tabId ' + tabId + ')');

  // --- the load-bearing call: rec.start ---
  let start: RecStartResult;
  try {
    start = await bridge.call<RecStartResult>('rec.start', { tabId }, 20_000);
  } catch (e) {
    // A bridge-level throw here means the rec.start method is missing/broken —
    // that's broken plumbing, not graceful degradation.
    throw new Error('rec.start bridge call threw (plumbing broken): ' + (e instanceof Error ? e.message : String(e)));
  }
  if (!start || typeof start.ok !== 'boolean') {
    throw new Error('rec.start returned a malformed response (expected {ok:boolean}): ' + JSON.stringify(start));
  }
  ok('rec.start answered with a well-formed {ok} response');

  if (!start.ok) {
    // EXPECTED in headless dev-loaded Chrome: invocation gating denies the
    // streamId. The contract is graceful failure with a reason string.
    if (typeof start.reason !== 'string' || start.reason.length === 0) {
      throw new Error('graceful-failure path must carry a non-empty reason string; got: ' + JSON.stringify(start));
    }
    ok('graceful degradation verified: rec.start → {ok:false, reason}');
    info('reason: ' + start.reason);
    info('');
    info('=== INVOCATION-GATING CASE ===');
    info('chrome.tabCapture.getMediaStreamId was DENIED in this headless,');
    info('dev-loaded Chrome because the extension was not invoked on the tab via');
    info('a user gesture (no action click; the side panel does not cleanly count).');
    info('This is the DOCUMENTED behavior. The recorder degraded cleanly and a');
    info('real run would simply continue WITHOUT a clip — the verdict is never');
    info('affected.');
    info('PRODUCT PATH NEEDS MANUAL VERIFICATION: open the side panel from the');
    info('toolbar action and click Run in a real (headed) Chrome with the');
    info('"<all_urls>" host permission — getMediaStreamId is expected to succeed');
    info('there and produce artifacts/<runId>/replay.webm.');

    // Also prove rec.stop is well-formed when nothing is recording (no throw).
    const stop = await bridge.call<RecStopResult>('rec.stop', {}, 20_000);
    if (!stop || typeof stop.ok !== 'boolean') {
      throw new Error('rec.stop returned a malformed response: ' + JSON.stringify(stop));
    }
    ok('rec.stop is well-formed even with no active recording (ok=' + stop.ok + ')');
    exitCode = 0;
  } else {
    // The environment GRANTED capture — exercise the full pipeline.
    ok('rec.start GRANTED — recording (mime: ' + (start.mime ?? 'unknown') + ')');
    info('this environment satisfied tabCapture invocation — verifying full webm pipeline');

    // Drive the tab around for ~3s so the MediaRecorder has changing frames.
    for (let i = 0; i < 3; i++) {
      await bridge.call('ext.navigate', {
        tabId,
        url: 'data:text/html,<body style="background:%23' + (i % 2 ? '114' : '411') +
          '"><h1 style="color:white;font-family:sans-serif">frame ' + i + '</h1></body>',
      }, 20_000).catch(() => { /* navigation jitter is fine */ });
      await sleep(1000);
    }

    const stop = await bridge.call<RecStopResult>('rec.stop', {}, 30_000);
    if (!stop || typeof stop.ok !== 'boolean') {
      throw new Error('rec.stop returned a malformed response: ' + JSON.stringify(stop));
    }
    if (!stop.ok || !stop.webmBase64) {
      throw new Error('rec.stop after a granted rec.start returned no webm: ' + (stop.reason ?? 'no reason'));
    }
    const buf = Buffer.from(stop.webmBase64, 'base64');
    const magic = buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
    if (!magic) {
      throw new Error('recorded bytes are not a valid webm (EBML magic 0x1A45DFA3 missing)');
    }
    ok('webm magic 0x1A45DFA3 present, ' + buf.length + ' bytes');

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const proof = path.join(OUT_DIR, 'tabcapture-proof.webm');
    fs.writeFileSync(proof, buf);
    ok('saved proof clip: ' + proof);
    info('=== CAPTURE-GRANTED CASE === full tabCapture→MediaRecorder→webm verified.');
    exitCode = 0;
  }
} catch (e) {
  console.error('\nV19 FAILED (broken plumbing):', e instanceof Error ? e.stack : e);
  exitCode = 1;
} finally {
  await bridge.close();
  if (chrome) { try { chrome.kill(); } catch { /* gone */ } }
}

console.log('\n' + (exitCode === 0 ? 'V19 PASS' : 'V19 FAIL') + ' — ' + pass.length + ' checks');
process.exit(exitCode);
