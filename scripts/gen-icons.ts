/* gen-icons.ts — generate the MV3 extension icons programmatically.
 *
 * Approach: spawn a throwaway headless Chrome via the project's own launch
 * helpers (findChrome / ensureChrome), open a data: URL page that draws the
 * icon on a <canvas> at each exact size (a rounded-rect green gradient plaque
 * with a white robot/checkmark glyph), read each canvas back as a PNG data URL
 * via toDataURL, and write the four PNGs. A contact sheet proof is rendered on
 * its own canvas and saved to artifacts/icons-proof.png.
 *
 * Rerunnable: reuses a live Chrome on CDP port 9343 if present, else spawns one
 * detached. Throwaway profile under the OS temp dir.
 *
 *   npx tsx scripts/gen-icons.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ensureChrome, openTab, closeTab, evalIn } from '../src/chrome/launch.js';

const CDP_PORT = 9343;
const SIZES = [16, 32, 48, 128] as const;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const ICONS_DIR = path.join(REPO, 'extension', 'icons');
const ARTIFACTS_DIR = path.join(REPO, 'artifacts');
const PROFILE = path.join(os.tmpdir(), 'qa-icon-gen-profile');

/** The canvas drawing routine, stringified and run inside the page.
 * Draws one icon at side `s` onto ctx. Kept as a JS string so it runs in the
 * browser; the same source is reused for each size and for the contact sheet. */
const DRAW_FN = `
function drawIcon(ctx, s) {
  ctx.clearRect(0, 0, s, s);
  // rounded-rect plaque with a green vertical gradient
  const r = Math.max(2, Math.round(s * 0.18));
  const grad = ctx.createLinearGradient(0, 0, 0, s);
  grad.addColorStop(0, '#16a34a');
  grad.addColorStop(1, '#15803d');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(s, 0, s, s, r);
  ctx.arcTo(s, s, 0, s, r);
  ctx.arcTo(0, s, 0, 0, r);
  ctx.arcTo(0, 0, s, 0, r);
  ctx.closePath();
  ctx.fill();

  // white robot glyph drawn with paths (scales crisply at all sizes)
  ctx.save();
  ctx.translate(s / 2, s / 2);
  const u = s / 100; // unit so coordinates are in a 100x100 design space
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ffffff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // antenna
  ctx.lineWidth = 6 * u;
  ctx.beginPath();
  ctx.moveTo(0, -34 * u);
  ctx.lineTo(0, -24 * u);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, -38 * u, 5 * u, 0, Math.PI * 2);
  ctx.fill();

  // head (rounded rect)
  const hw = 46 * u, hh = 38 * u, hr = 9 * u;
  const x = -hw / 2, y = -22 * u;
  ctx.beginPath();
  ctx.moveTo(x + hr, y);
  ctx.arcTo(x + hw, y, x + hw, y + hh, hr);
  ctx.arcTo(x + hw, y + hh, x, y + hh, hr);
  ctx.arcTo(x, y + hh, x, y, hr);
  ctx.arcTo(x, y, x + hw, y, hr);
  ctx.closePath();
  ctx.fill();

  // eyes (green knockout) — make a checkmark out of the right "eye" area below
  ctx.fillStyle = '#15803d';
  const eyeR = 5 * u;
  ctx.beginPath();
  ctx.arc(-11 * u, -2 * u, eyeR, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(11 * u, -2 * u, eyeR, 0, Math.PI * 2);
  ctx.fill();

  // checkmark in a circle below the head — the "QA passed" mark
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(0, 28 * u, 16 * u, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#16a34a';
  ctx.lineWidth = 5 * u;
  ctx.beginPath();
  ctx.moveTo(-7 * u, 28 * u);
  ctx.lineTo(-1 * u, 34 * u);
  ctx.lineTo(8 * u, 22 * u);
  ctx.stroke();
  ctx.restore();
}
`;

/** Render one size and return its PNG data URL. */
async function renderSize(client: import('chrome-remote-interface').Client, s: number): Promise<string> {
  return evalIn<string>(
    client,
    `(() => {
      ${DRAW_FN}
      const c = document.createElement('canvas');
      c.width = ${s}; c.height = ${s};
      const ctx = c.getContext('2d');
      drawIcon(ctx, ${s});
      return c.toDataURL('image/png');
    })()`,
  );
}

/** Render a contact sheet of all sizes on a light background. */
async function renderProof(client: import('chrome-remote-interface').Client): Promise<string> {
  return evalIn<string>(
    client,
    `(() => {
      ${DRAW_FN}
      const sizes = [${SIZES.join(',')}];
      const pad = 24, gap = 32, big = 128;
      const w = pad * 2 + sizes.reduce((a, b) => a + b + gap, 0) - gap;
      const h = pad * 2 + big + 28;
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#f3f4f6';
      ctx.fillRect(0, 0, w, h);
      let x = pad;
      const baseY = pad;
      for (const s of sizes) {
        const tmp = document.createElement('canvas');
        tmp.width = s; tmp.height = s;
        drawIcon(tmp.getContext('2d'), s);
        // align bottoms so size growth is visible
        ctx.drawImage(tmp, x, baseY + (big - s));
        ctx.fillStyle = '#374151';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(s + 'px', x + s / 2, baseY + big + 20);
        x += s + gap;
      }
      return c.toDataURL('image/png');
    })()`,
  );
}

function dataUrlToBuffer(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(',');
  if (comma < 0 || !dataUrl.startsWith('data:image/png;base64,')) {
    throw new Error('unexpected data URL prefix: ' + dataUrl.slice(0, 40));
  }
  return Buffer.from(dataUrl.slice(comma + 1), 'base64');
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function assertValidPng(buf: Buffer, label: string): void {
  if (buf.length < 200) throw new Error(`${label}: too small (${buf.length} bytes)`);
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) throw new Error(`${label}: bad PNG magic bytes`);
}

async function main(): Promise<void> {
  fs.mkdirSync(ICONS_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

  console.log(`[gen-icons] ensuring headless Chrome on CDP ${CDP_PORT} …`);
  await ensureChrome({ port: CDP_PORT, profileDir: PROFILE, headless: true });
  const tab = await openTab(CDP_PORT, 'about:blank');

  try {
    for (const s of SIZES) {
      const dataUrl = await renderSize(tab.client, s);
      const buf = dataUrlToBuffer(dataUrl);
      assertValidPng(buf, `icon${s}`);
      const out = path.join(ICONS_DIR, `icon${s}.png`);
      fs.writeFileSync(out, buf);
      console.log(`[gen-icons] wrote ${path.relative(REPO, out)} (${buf.length} bytes)`);
    }

    const proof = dataUrlToBuffer(await renderProof(tab.client));
    assertValidPng(proof, 'contact-sheet');
    const proofPath = path.join(ARTIFACTS_DIR, 'icons-proof.png');
    fs.writeFileSync(proofPath, proof);
    console.log(`[gen-icons] wrote ${path.relative(REPO, proofPath)} (${proof.length} bytes)`);
  } finally {
    await closeTab(CDP_PORT, tab);
  }

  console.log('[gen-icons] done — 4 icons + contact sheet proof.');
}

main().catch((err) => {
  console.error('[gen-icons] FAILED:', err);
  process.exit(1);
});
