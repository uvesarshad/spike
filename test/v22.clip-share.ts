/* V22 — clip share (vibe.clip) reverse-RPC round-trip. NO Chrome needed.
 *
 * A plain `ws` client stands in for the side panel (the fake-ws-client style from
 * v7). It connects to a real BridgeServer on the ISOLATED port 9427, with a real
 * VibeService wired on top. We stub the service's "last saved clip" by writing a
 * tiny temp file and pointing the service at it via the test seam
 * VibeService.noteClipForTest(path) — no run, no Chrome, no recorder.
 *
 * Then we drive vibe.clip over the reverse-RPC channel ({rid, method}) and assert:
 *   - the {rid, result} carries {name, mime, dataBase64}
 *   - the base64 round-trips byte-for-byte back to the bytes we wrote
 *   - mime is derived from the extension (.webm → video/webm, .mp4 → video/mp4)
 *   - with NO clip noted, vibe.clip answers {rid, error:'no clip from the last run'}
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { BridgeServer } from '../src/bridge/bridge-server.js';
import { VibeService } from '../src/vibe/service.js';

const BRIDGE_PORT = 9427;

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const bridge = new BridgeServer(BRIDGE_PORT);
  const vibe = new VibeService(bridge);
  vibe.start();

  // Stub the "last saved clip": a tiny temp file with a recognisable byte pattern.
  // Use a .webm name + webm EBML magic so it's a plausible clip; the service maps
  // the .webm extension → video/webm.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-v22-'));
  const clipBytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04, 0xff, 0xfe]);
  const clipPath = path.join(tmpDir, 'replay.webm');
  fs.writeFileSync(clipPath, clipBytes);

  const ws = new WebSocket(`ws://localhost:${BRIDGE_PORT}/`);
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });

  const responses = new Map<number, { result?: unknown; error?: string }>();
  ws.on('message', (data) => {
    try {
      const m = JSON.parse(data.toString());
      if (typeof m.rid === 'number') responses.set(m.rid, { result: m.result, error: m.error });
    } catch { /* ignore */ }
  });

  const send = (obj: unknown) => ws.send(JSON.stringify(obj));
  const waitFor = async (rid: number, ms = 2000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (responses.has(rid)) return responses.get(rid)!;
      await sleep(10);
    }
    return undefined;
  };

  // --- 1) no clip yet → error -------------------------------------------------
  send({ rid: 1, method: 'vibe.clip' });
  const r1 = await waitFor(1);
  check(
    "vibe.clip with no clip → error 'no clip from the last run'",
    !!r1 && typeof r1.error === 'string' && r1.error.includes('no clip from the last run'),
  );

  // --- 2) note a clip via the test seam, then fetch it ------------------------
  vibe.noteClipForTest(clipPath);
  send({ rid: 2, method: 'vibe.clip' });
  const r2 = await waitFor(2);
  const res = (r2 && r2.result) as { name?: string; mime?: string; dataBase64?: string } | undefined;
  check('vibe.clip returns a result (no error)', !!r2 && r2.error === undefined && !!res);
  check('vibe.clip result.name is replay.webm', !!res && res.name === 'replay.webm');
  check('vibe.clip result.mime is video/webm', !!res && res.mime === 'video/webm');

  // base64 round-trips byte-for-byte
  const decoded = res && typeof res.dataBase64 === 'string' ? Buffer.from(res.dataBase64, 'base64') : Buffer.alloc(0);
  check('vibe.clip dataBase64 round-trips to the exact bytes', decoded.equals(clipBytes));

  // --- 3) mp4 extension → video/mp4 mime --------------------------------------
  const mp4Bytes = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]); // ...ftyp
  const mp4Path = path.join(tmpDir, 'replay.mp4');
  fs.writeFileSync(mp4Path, mp4Bytes);
  vibe.noteClipForTest(mp4Path);
  send({ rid: 3, method: 'vibe.clip' });
  const r3 = await waitFor(3);
  const res3 = (r3 && r3.result) as { name?: string; mime?: string; dataBase64?: string } | undefined;
  check('vibe.clip (.mp4) result.name is replay.mp4', !!res3 && res3.name === 'replay.mp4');
  check('vibe.clip (.mp4) result.mime is video/mp4', !!res3 && res3.mime === 'video/mp4');
  const decoded3 = res3 && typeof res3.dataBase64 === 'string' ? Buffer.from(res3.dataBase64, 'base64') : Buffer.alloc(0);
  check('vibe.clip (.mp4) dataBase64 round-trips', decoded3.equals(mp4Bytes));

  // --- 4) a deleted file behind a noted path → graceful error -----------------
  fs.rmSync(clipPath);
  fs.rmSync(mp4Path);
  vibe.noteClipForTest(path.join(tmpDir, 'gone.webm'));
  send({ rid: 4, method: 'vibe.clip' });
  const r4 = await waitFor(4);
  check(
    'vibe.clip with a missing file → error (no crash)',
    !!r4 && typeof r4.error === 'string' && r4.error.includes('no clip from the last run'),
  );

  ws.close();
  await bridge.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
}

await main();

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v22 checks passed`);
process.exit(failed.length ? 1 : 0);
