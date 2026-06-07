/* V15 — recorder robustness (scripted, no AI).
 *
 * 1. diffScripts unit tests: added / removed / changed-by-index, and "no changes".
 * 2. Duplicate-target disambiguation, end to end over a real CdpBrowser:
 *    an inline page with TWO buttons both named "Edit" (+ a page-side click
 *    counter per button).
 *      a. A QaScript that clicks { role:'button', name:'Edit' } with NO nth →
 *         replay FAILS with the precise 'ambiguous locator' error.
 *      b. The same script with nth:1 → replay PASSES, and the SECOND button's
 *         counter incremented (read through Runtime), proving nth selects the
 *         right one of N matches.
 *
 * Isolated: CDP 9336, inline HTTP server on an ephemeral port. Kills Chrome in
 * finally. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import CDP from 'chrome-remote-interface';
import { CdpBrowser } from '../src/ports/cdp-browser.js';
import { ArtifactStore } from '../src/report/artifacts.js';
import { replayScript } from '../src/recorder/replay.js';
import { diffScripts, type QaScript } from '../src/recorder/script.js';

const CDP_PORT = 9336;

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

/* ---------- 1. diffScripts unit tests (pure, no browser) ---------- */

const baseScript = (steps: QaScript['steps']): QaScript => ({
  version: 1,
  name: 'diff-fixture',
  task: 't',
  url: 'http://x/',
  sourceRunId: 'r',
  createdAt: '2026-01-01T00:00:00.000Z',
  steps,
});

const s1 = baseScript([
  { type: 'navigate', url: 'http://x/a' },
  { type: 'click', target: { role: 'button', name: 'Save' } },
  { type: 'type', target: { role: 'textbox', name: 'Email' }, text: 'a@b.co' },
]);

// identical
check('diffScripts: identical → "no changes"', diffScripts(s1, s1).startsWith('no changes'));

// changed step (target name) at index 1
const s2 = baseScript([
  { type: 'navigate', url: 'http://x/a' },
  { type: 'click', target: { role: 'button', name: 'Submit' } },
  { type: 'type', target: { role: 'textbox', name: 'Email' }, text: 'a@b.co' },
]);
const d2 = diffScripts(s1, s2);
check('diffScripts: changed step shows "~ [1] changed"', d2.includes('~ [1] changed') && d2.includes('Save') && d2.includes('Submit'));

// added step (s3 longer)
const s3 = baseScript([
  ...s1.steps,
  { type: 'click', target: { role: 'button', name: 'Place order' } },
]);
const d3 = diffScripts(s1, s3);
check('diffScripts: added step shows "+ [3] added"', d3.includes('+ [3] added') && d3.includes('Place order'));

// removed step (s1 longer than s4)
const s4 = baseScript([s1.steps[0], s1.steps[1]]);
const d4 = diffScripts(s1, s4);
check('diffScripts: removed step shows "- [2] removed"', d4.includes('- [2] removed'));

/* ---------- 2. ambiguous-locator + nth, end to end ---------- */

const PAGE = `<!DOCTYPE html><html><head><title>dup</title></head><body>
  <h1>Two edits</h1>
  <button id="e0">Edit</button>
  <button id="e1">Edit</button>
  <p id="log">c0=0 c1=0</p>
  <script>
    window.__clicks = [0, 0];
    const render = () => document.getElementById('log').textContent =
      'c0=' + window.__clicks[0] + ' c1=' + window.__clicks[1];
    document.getElementById('e0').addEventListener('click', () => { window.__clicks[0]++; render(); });
    document.getElementById('e1').addEventListener('click', () => { window.__clicks[1]++; render(); });
  </script>
</body></html>`;

const server = http.createServer((_req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(PAGE);
});
await new Promise<void>((resolve) => server.listen(0, resolve));
const addr = server.address() as import('node:net').AddressInfo;
const pageUrl = `http://localhost:${addr.port}/`;

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-v15-'));
const artRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-v15-art-'));

const ambiguousScript: QaScript = {
  version: 1,
  name: 'dup-ambiguous',
  task: 'click an Edit button',
  url: pageUrl,
  sourceRunId: 'r-amb',
  createdAt: new Date().toISOString(),
  steps: [{ type: 'click', target: { role: 'button', name: 'Edit' } }],
};

const nthScript: QaScript = {
  ...ambiguousScript,
  name: 'dup-nth',
  steps: [{ type: 'click', target: { role: 'button', name: 'Edit', nth: 1 } }],
};

const browser = new CdpBrowser({ port: CDP_PORT, profileDir, headless: true });
const probeRef: { client: CDP.Client | null } = { client: null };

/** Read window.__clicks from the live tab via a second raw CDP client. */
async function readClicks(): Promise<[number, number]> {
  if (!probeRef.client) {
    const targets = await CDP.List({ port: CDP_PORT });
    const pageTarget = targets.find((t) => t.type === 'page' && t.url.startsWith(pageUrl));
    probeRef.client = await CDP({ port: CDP_PORT, target: pageTarget!.id });
  }
  const { result } = await probeRef.client.Runtime.evaluate({
    expression: 'JSON.stringify(window.__clicks || [0,0])',
    returnByValue: true,
  });
  return JSON.parse(result.value as string) as [number, number];
}

try {
  await browser.launch();

  // (a) ambiguous: no nth, two matches → replay must FAIL precisely.
  const ambArtifacts = new ArtifactStore(artRoot);
  const ambReport = await replayScript(browser, null, ambArtifacts, ambiguousScript, {});
  check('ambiguous replay verdict is fail', ambReport.verdict === 'fail');
  check(
    "ambiguous replay error is the precise 'ambiguous locator' message",
    /ambiguous locator: 2 × button "Edit"/.test(ambReport.reason),
  );
  const afterAmb = await readClicks();
  check('ambiguous replay did NOT click either button (no silent first-match)', afterAmb[0] === 0 && afterAmb[1] === 0);

  // (b) nth:1 → replay PASSES and the SECOND button got clicked.
  const nthArtifacts = new ArtifactStore(artRoot);
  const nthReport = await replayScript(browser, null, nthArtifacts, nthScript, {});
  check('nth:1 replay verdict is pass', nthReport.verdict === 'pass');
  const afterNth = await readClicks();
  check('nth:1 clicked the SECOND Edit button (c1=1, c0=0)', afterNth[0] === 0 && afterNth[1] === 1);
} catch (e) {
  console.error('V15 FAILED:', e instanceof Error ? (e.stack ?? e.message) : e);
  check('ran without throwing', false);
} finally {
  if (probeRef.client) { try { await probeRef.client.close(); } catch { /* */ } }
  try { await browser.close(); } catch { /* */ }
  try {
    const browserClient = await CDP({ port: CDP_PORT });
    await browserClient.Browser.close().catch(() => {});
    await browserClient.close().catch(() => {});
  } catch { /* gone */ }
  await new Promise<void>((r) => server.close(() => r()));
  try { fs.rmSync(artRoot, { recursive: true, force: true }); } catch { /* */ }
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* */ }
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v15 checks passed`);
process.exit(failed.length ? 1 : 0);
