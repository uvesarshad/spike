/* V97 — the evidence a person can actually hand to someone (audit finding A15).
 *
 * Every run was already taking screenshots, and nothing ever showed one: the
 * panel had no reference to a screenshot at all, the browser-only mode produced
 * nothing downloadable, and the fix prompt cited "step-06.png" — a filename
 * that means nothing to a web-based coding tool.
 *
 * Pinned here:
 *   1. `headlineScreenshot` picks the useful frame — the failing step's when
 *      the run failed, the last one when it passed, nothing when there are none;
 *   2. the hand-rolled ZIP writer produces an archive a real unzip can read
 *      (checked by parsing the central directory back out, byte by byte);
 *   3. the fix prompt inlines the failing screenshot as a data URI when it fits
 *      under the cap, and falls back to the bare filename when it doesn't.
 *
 * Pure/in-memory. No Chrome, no network, no API keys.
 *
 * Run: npx tsx test/v97.evidence-bundle.ts
 */

import assert from 'node:assert/strict';
import { headlineScreenshot, type Report } from '../src/report/report.js';
import { crc32, makeZip } from '../src/report/zip.js';
import { buildFixPrompt, dataUri, MAX_FIX_PROMPT_IMAGE_BYTES } from '../src/vibe/fix-prompt.js';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL  ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const DIR = 'artifacts/2026-09-13_10-00-00-abcd';
function reportWith(over: Partial<Report>): Report {
  return {
    runId: 'abcd',
    task: 'check the cart',
    url: 'http://x.test/',
    verdict: 'fail',
    reason: 'the button did nothing',
    steps: [],
    evidence_paths: [
      `${DIR}/report.json`,
      `${DIR}/screenshots/step-00.png`,
      `${DIR}/screenshots/step-06.png`,
      `${DIR}/screenshots/step-09.png`,
    ],
    durationMs: 1,
    model_trace: [],
    ...over,
  } as unknown as Report;
}

// ---- 1. picking the frame worth showing ------------------------------------

check('a failed run shows the frame of the step that failed', () => {
  const r = reportWith({ failing_step: { index: 6 } as Report['failing_step'] });
  assert.equal(headlineScreenshot(r), `${DIR}/screenshots/step-06.png`);
});

check('a passing run shows the last frame — the state it ended on', () => {
  const r = reportWith({ verdict: 'pass', failing_step: undefined });
  assert.equal(headlineScreenshot(r), `${DIR}/screenshots/step-09.png`);
});

check('a failing step with no frame of its own falls back to the last one', () => {
  const r = reportWith({ failing_step: { index: 42 } as Report['failing_step'] });
  assert.equal(headlineScreenshot(r), `${DIR}/screenshots/step-09.png`);
});

check('a run that captured nothing offers nothing', () => {
  assert.equal(headlineScreenshot(reportWith({ evidence_paths: [`${DIR}/report.json`] })), undefined);
});

check('report.json is never mistaken for a picture', () => {
  assert.ok(!String(headlineScreenshot(reportWith({}))).endsWith('.json'));
});

// ---- 2. the zip is a real zip ----------------------------------------------
//
// Parsed back out of the bytes rather than trusted: a hand-rolled archive that
// no tool can open is worse than no archive at all.

function u16(b: Uint8Array, at: number): number {
  return b[at] | (b[at + 1] << 8);
}
function u32(b: Uint8Array, at: number): number {
  return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
}

interface ParsedEntry { name: string; data: Uint8Array; crc: number }

/** Read a STORED archive back via its central directory, the way a real
 * unzip does — not by re-walking the local headers we just wrote. */
function readZip(zip: Uint8Array): ParsedEntry[] {
  // End of central directory: fixed size here (we never write a comment).
  const eocd = zip.length - 22;
  assert.equal(u32(zip, eocd), 0x06054b50, 'no end-of-central-directory signature');
  const count = u16(zip, eocd + 10);
  let at = u32(zip, eocd + 16);
  const out: ParsedEntry[] = [];
  for (let i = 0; i < count; i++) {
    assert.equal(u32(zip, at), 0x02014b50, `entry ${i}: bad central header`);
    const crc = u32(zip, at + 16);
    const size = u32(zip, at + 24);
    const nameLen = u16(zip, at + 28);
    const extraLen = u16(zip, at + 30);
    const commentLen = u16(zip, at + 32);
    const localAt = u32(zip, at + 42);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen));
    assert.equal(u32(zip, localAt), 0x04034b50, `entry ${i}: bad local header`);
    const localNameLen = u16(zip, localAt + 26);
    const localExtraLen = u16(zip, localAt + 28);
    const dataAt = localAt + 30 + localNameLen + localExtraLen;
    out.push({ name, data: zip.subarray(dataAt, dataAt + size), crc });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const REPORT = new TextEncoder().encode('{"verdict":"fail"}');
const SHOT = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 0xff, 0]);

check('the archive round-trips: names, bytes and checksums', () => {
  const zip = makeZip([
    { path: 'report.json', data: REPORT },
    { path: 'screenshots/step-06.png', data: SHOT },
  ]);
  const entries = readZip(zip);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.name), ['report.json', 'screenshots/step-06.png']);
  assert.deepEqual([...entries[0].data], [...REPORT]);
  assert.deepEqual([...entries[1].data], [...SHOT]);
  for (const e of entries) assert.equal(e.crc, crc32(e.data), `${e.name}: checksum mismatch`);
});

check('a known CRC32 matches the standard', () => {
  // "123456789" → 0xCBF43926, the canonical CRC-32 check value.
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

check('an empty archive is still a valid one', () => {
  assert.deepEqual(readZip(makeZip([])), []);
});

check('windows separators and leading slashes are normalised away', () => {
  const entries = readZip(makeZip([{ path: '\\screenshots\\step-01.png', data: SHOT }]));
  assert.equal(entries[0].name, 'screenshots/step-01.png');
});

check('a zero-byte file survives', () => {
  const entries = readZip(makeZip([{ path: 'empty.txt', data: new Uint8Array(0) }]));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].data.length, 0);
});

// ---- 3. the fix prompt carries the picture ---------------------------------

const failing = reportWith({ failing_step: { index: 6 } as Report['failing_step'] });

check('a small screenshot is inlined, and its filename line is not repeated', () => {
  const uri = dataUri(Buffer.from(SHOT).toString('base64'));
  const prompt = buildFixPrompt(failing, { screenshotDataUri: uri });
  assert.ok(prompt.includes(`![failing step](${uri})`), 'the image is not inlined');
  assert.ok(!prompt.includes('- Screenshot: step-06.png'), 'the bare filename is duplicated');
  assert.ok(prompt.includes('- Screenshot: step-09.png'), 'the other frames should still be named');
});

check('an oversized screenshot falls back to the bare filename', () => {
  const huge = dataUri('A'.repeat(MAX_FIX_PROMPT_IMAGE_BYTES + 10));
  const prompt = buildFixPrompt(failing, { screenshotDataUri: huge });
  assert.ok(!prompt.includes('data:image/png;base64,AAA'), 'the oversized image was embedded anyway');
  assert.ok(prompt.includes('- Screenshot: step-06.png'), 'the fallback line is missing');
});

check('no screenshot supplied behaves exactly as before', () => {
  const prompt = buildFixPrompt(failing);
  assert.ok(prompt.includes('- Screenshot: step-06.png'));
  assert.ok(!prompt.includes('data:image/'));
});

check('something that is not an image is refused', () => {
  const prompt = buildFixPrompt(failing, { screenshotDataUri: 'javascript:alert(1)' });
  assert.ok(!prompt.includes('javascript:'));
  assert.ok(prompt.includes('- Screenshot: step-06.png'));
});

console.log(failures === 0 ? '\nV97 OK' : `\nV97 FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
