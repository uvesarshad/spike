/* V21 — locator hardening (scripted, no AI).
 *
 * Covers Phase-3.6 items #6 (recorder nth auto-populate) and #9 (data-qa-id
 * fallback locator):
 *
 *   (a) rankByRoleName (the loop's nth-computation helper): a tree with two
 *       same-named buttons gives count=2 and 0/1 by document order; a unique
 *       node gives count=1.
 *   (b) stampQaId + findByQaId round-trip on a real CdpBrowser: stamp the
 *       name-less icon button, then locate it back by the returned id → a nodeId
 *       that click() drives (proven by a page-side counter).
 *   (c) replay of a hand-built QaScript whose target is qaId-ONLY (no name)
 *       reaches the name-less button via the findByQaId fallback and clicks it.
 *   (d) Playwright codegen emits a [data-qa-id="…"] locator for a qaId-only,
 *       name-less target.
 *
 * Isolated: CDP 9344, fixture HTTP 9423. Fixture page: two buttons both named
 * "Save" + one name-less icon-button (aria-label stripped; just an SVG glyph).
 * Kills Chrome in finally. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import CDP from 'chrome-remote-interface';
import { CdpBrowser } from '../src/ports/cdp-browser.js';
import { ArtifactStore } from '../src/report/artifacts.js';
import { replayScript } from '../src/recorder/replay.js';
import { rankByRoleName } from '../src/driver/loop.js';
import { toPlaywrightSpec, type QaScript } from '../src/recorder/script.js';
import type { AxNode } from '../src/ports/browser-port.js';

const CDP_PORT = 9344;
const HTTP_PORT = 9423;

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

/* ---------- (a) rankByRoleName helper (pure, no browser) ---------- */

// A small AxNode tree: root → [button "Save"(b0), div → button "Save"(b1), button "Other"(b2)].
// Document (pre-order, recursive-children) order of the two "Save" buttons: b0 then b1.
const tree: AxNode = {
  id: 'root',
  role: 'WebArea',
  children: [
    { id: 'b0', role: 'button', name: 'Save' },
    {
      id: 'wrap',
      role: 'generic',
      children: [{ id: 'b1', role: 'button', name: 'Save' }],
    },
    { id: 'b2', role: 'button', name: 'Other' },
  ],
};

const r0 = rankByRoleName(tree, 'button', 'Save', 'b0');
check('rankByRoleName: count=2 for duplicate "Save"', r0.count === 2);
check('rankByRoleName: first "Save" → index 0 (document order)', r0.index === 0);
const r1 = rankByRoleName(tree, 'button', 'Save', 'b1');
check('rankByRoleName: second "Save" → index 1 (document order)', r1.count === 2 && r1.index === 1);
const rU = rankByRoleName(tree, 'button', 'Other', 'b2');
check('rankByRoleName: unique node → count=1, index 0', rU.count === 1 && rU.index === 0);

/* ---------- (d) Playwright codegen for qaId-only target (pure) ---------- */

const qaIdScript: QaScript = {
  version: 1,
  name: 'qa-codegen',
  task: 'click the icon button',
  url: `http://localhost:${HTTP_PORT}/`,
  sourceRunId: 'r-codegen',
  createdAt: new Date().toISOString(),
  // name-less target carrying only a stamped qaId
  steps: [{ type: 'click', target: { role: 'button', qaId: 'qa-deadbeef' } }],
};
const spec = toPlaywrightSpec(qaIdScript);
check(
  '(d) Playwright codegen emits [data-qa-id="…"] locator for name-less qaId target',
  spec.includes(`page.locator("[data-qa-id=\\"qa-deadbeef\\"]").click()`),
);

/* ---------- fixture page: two "Save" buttons + a name-less icon button ---------- */

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>locators</title></head><body>
  <h1>Locator fixture</h1>
  <button id="s0">Save</button>
  <button id="s1">Save</button>
  <!-- name-less icon button (no baked id): exercises runtime stampQaId (#9). -->
  <button id="icon"><svg width="16" height="16" aria-hidden="true"><rect width="16" height="16"></rect></svg></button>
  <!-- name-less icon button WITH a baked data-qa-id: survives reload, so it
       exercises the replay qaId fallback the way a stamped id would on a page
       that didn't reload. -->
  <button id="icon2" data-qa-id="qa-icon2"><svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="7"></circle></svg></button>
  <p id="log">s0=0 s1=0 icon=0 icon2=0</p>
  <script>
    window.__clicks = { s0: 0, s1: 0, icon: 0, icon2: 0 };
    const render = () => document.getElementById('log').textContent =
      's0=' + window.__clicks.s0 + ' s1=' + window.__clicks.s1 +
      ' icon=' + window.__clicks.icon + ' icon2=' + window.__clicks.icon2;
    for (const id of ['s0', 's1', 'icon', 'icon2']) {
      document.getElementById(id).addEventListener('click', () => { window.__clicks[id]++; render(); });
    }
  </script>
</body></html>`;

const server = http.createServer((_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(PAGE);
});
await new Promise<void>((resolve) => server.listen(HTTP_PORT, resolve));
const pageUrl = `http://localhost:${HTTP_PORT}/`;

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-v21-'));
const artRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-v21-art-'));

const browser = new CdpBrowser({ port: CDP_PORT, profileDir, headless: true });
const probeRef: { client: CDP.Client | null } = { client: null };

async function readClicks(): Promise<{ s0: number; s1: number; icon: number; icon2: number }> {
  if (!probeRef.client) {
    const targets = await CDP.List({ port: CDP_PORT });
    const pageTarget = targets.find((t) => t.type === 'page' && t.url.startsWith(pageUrl));
    probeRef.client = await CDP({ port: CDP_PORT, target: pageTarget!.id });
  }
  const { result } = await probeRef.client.Runtime.evaluate({
    expression: 'JSON.stringify(window.__clicks || {s0:0,s1:0,icon:0,icon2:0})',
    returnByValue: true,
  });
  return JSON.parse(result.value as string);
}

function findByName(node: AxNode, role: string, name: string): AxNode | undefined {
  if (node.role === role && node.name === name) return node;
  for (const c of node.children ?? []) {
    const hit = findByName(c, role, name);
    if (hit) return hit;
  }
  return undefined;
}

/** The name-less icon button: a button node with no name (or empty name). */
function findNamelessButton(node: AxNode): AxNode | undefined {
  if (node.role === 'button' && !node.name) return node;
  for (const c of node.children ?? []) {
    const hit = findNamelessButton(c);
    if (hit) return hit;
  }
  return undefined;
}

try {
  await browser.launch();
  await browser.navigate(pageUrl);

  /* ---------- (b) stampQaId + findByQaId round-trip ---------- */
  const ax = await browser.axTree();
  const iconNode = findNamelessButton(ax.root);
  check('(b) fixture exposes a name-less button node in the a11y tree', Boolean(iconNode));

  const stampedId = iconNode ? await browser.stampQaId(iconNode.id) : null;
  check('(b) stampQaId returned a qa-* id', typeof stampedId === 'string' && /^qa-[0-9a-f]{8}$/.test(stampedId!));

  const foundNodeId = stampedId ? await browser.findByQaId(stampedId) : null;
  check('(b) findByQaId round-trips to a nodeId', typeof foundNodeId === 'string' && foundNodeId!.length > 0);

  // the returned nodeId must drive click() — counter proves it hit the icon button
  if (foundNodeId) await browser.click(foundNodeId);
  const afterStamp = await readClicks();
  check('(b) click(findByQaId id) clicked the icon button (icon=1, others 0)', afterStamp.icon === 1 && afterStamp.s0 === 0 && afterStamp.s1 === 0);

  // findByQaId for a never-stamped id → null (best-effort miss, no throw)
  const miss = await browser.findByQaId('qa-nonexistent');
  check('(b) findByQaId returns null for an absent id', miss === null);

  /* ---------- (c) replay via qaId fallback ---------- */
  // The script's role+name is AMBIGUOUS (two "Save" buttons), but it also carries
  // the baked data-qa-id of icon2. findByTarget must hit the ambiguous branch,
  // fall through to findByQaId, and click ICON2 (not a Save button) — proving the
  // fallback both fires and points where the id says. A baked id stands in for a
  // stamped one that survived (the documented caveat is stamps die on reload, and
  // replayScript navigates up front — so the realistic replay locator is a stable
  // attribute, which is exactly what a baked id models).
  // replayScript navigates to script.url up front, which RESETS window.__clicks,
  // so assert absolute post-replay counts (icon2=1, Save buttons=0).
  const replayScriptObj: QaScript = {
    version: 1,
    name: 'qa-fallback',
    task: 'click the icon button',
    url: pageUrl,
    sourceRunId: 'r-fallback',
    createdAt: new Date().toISOString(),
    steps: [{ type: 'click', target: { role: 'button', name: 'Save', qaId: 'qa-icon2' } }],
  };

  const artifacts = new ArtifactStore(artRoot);
  const rep = await replayScript(browser, null, artifacts, replayScriptObj, {});
  check('(c) qaId-fallback replay verdict is pass', rep.verdict === 'pass');
  const after = await readClicks();
  check('(c) qaId-fallback replay clicked icon2 via the attribute (icon2=1)', after.icon2 === 1);
  check('(c) qaId-fallback did NOT click a Save button', after.s0 === 0 && after.s1 === 0);
} catch (e) {
  console.error('V21 FAILED:', e instanceof Error ? (e.stack ?? e.message) : e);
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
console.log(`\n${checks.length - failed.length}/${checks.length} v21 checks passed`);
process.exit(failed.length ? 1 : 0);
