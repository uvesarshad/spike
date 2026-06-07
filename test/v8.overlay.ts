/* V8 verification — the GHOST CURSOR overlay renders.
 *
 * No daemon, no bridge: we drive the overlay content script directly. The flow:
 *   1. launchChromeWithExtension dev-loads the MV3 extension (headless) on CDP 9329.
 *   2. A tiny http server on 9404 serves a plain page so the <all_urls> content
 *      script (overlay.js) auto-injects at document_idle.
 *   3. Attach CDP to the service-worker target and Runtime.evaluate
 *      chrome.tabs.sendMessage(<tabId>, {target:'qa-overlay', ...}) — the same
 *      message the SW would forward from a daemon vibe.cursor event.
 *   4. Attach CDP to the PAGE target and assert: cursor element exists, caption
 *      text matches, a ripple ring appears after a 'click'.
 *   5. Capture a screenshot to artifacts/overlay-proof.png for visual proof.
 *
 * Exits nonzero on any failed assert; kills Chrome in finally.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import CDP from 'chrome-remote-interface';
import { sleep } from '../src/chrome/launch.js';
import { launchChromeWithExtension } from '../src/chrome/extensions.js';

const CDP_PORT = 9329; // throwaway, owned by launchChromeWithExtension
const HTTP_PORT = 9404; // our fixture server
const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const ARTIFACTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'artifacts');

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Overlay fixture</title>
<style>body{font:16px system-ui;margin:0;height:100vh;background:#f4f4f8;}
button{position:absolute;left:160px;top:120px;padding:10px 16px;}</style></head>
<body><button id="go">Go</button><p>ghost cursor fixture</p></body></html>`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-v8-'));
let chrome: Awaited<ReturnType<typeof launchChromeWithExtension>>['chrome'] | null = null;
let server: http.Server | null = null;

const results: { name: string; ok: boolean; detail?: string }[] = [];
const assert = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

/** Evaluate in a connected CDP client, awaiting promises, returning by value. */
async function evalIn<T>(client: CDP.Client, expression: string): Promise<T> {
  const { result, exceptionDetails } = await client.Runtime.evaluate({
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description ?? JSON.stringify(exceptionDetails));
  }
  return result.value as T;
}

try {
  fs.mkdirSync(ARTIFACTS, { recursive: true });

  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE_HTML);
  });
  await new Promise<void>((r) => server!.listen(HTTP_PORT, r));

  const launched = await launchChromeWithExtension({
    cdpPort: CDP_PORT,
    extensionDir: EXT_DIR,
    profileDir: profile,
    headless: true,
  });
  chrome = launched.chrome;
  const extId = launched.extensionId;
  console.log('loaded extension id:', extId);

  // Find the service-worker target (sw.js).
  let swTargetId: string | undefined;
  for (let i = 0; i < 40 && !swTargetId; i++) {
    const targets = await CDP.List({ port: CDP_PORT });
    swTargetId = targets.find((t) => t.url === `chrome-extension://${extId}/sw.js`)?.id;
    if (!swTargetId) await sleep(250);
  }
  assert('service worker target found', !!swTargetId, swTargetId ?? 'not found');
  if (!swTargetId) throw new Error('no SW target');

  const sw = await CDP({ port: CDP_PORT, target: swTargetId });
  await sw.Runtime.enable();

  // Open the fixture page in a real tab via the SW's chrome.tabs API, so the
  // <all_urls> content script injects. Returns the new tabId.
  const pageUrl = `http://localhost:${HTTP_PORT}/`;
  const tabId = await evalIn<number>(
    sw,
    `(async () => {
       const tab = await chrome.tabs.create({ url: ${JSON.stringify(pageUrl)}, active: true });
       return tab.id;
     })()`,
  );
  assert('fixture tab created', typeof tabId === 'number', `tabId=${tabId}`);

  // Wait for the page target to appear and finish loading.
  let pageTargetId: string | undefined;
  for (let i = 0; i < 40 && !pageTargetId; i++) {
    const targets = await CDP.List({ port: CDP_PORT });
    pageTargetId = targets.find((t) => t.type === 'page' && t.url.startsWith(pageUrl))?.id;
    if (!pageTargetId) await sleep(200);
  }
  assert('page target found', !!pageTargetId, pageTargetId ?? 'not found');
  if (!pageTargetId) throw new Error('no page target');

  const page = await CDP({ port: CDP_PORT, target: pageTargetId });
  await Promise.all([page.Page.enable(), page.Runtime.enable()]);
  await sleep(400); // document_idle content-script injection

  // sendMessage from the SW. The content script may not have injected yet, so
  // retry a few times until the overlay cursor element appears on the page.
  const sendMove = `(async () => {
     await new Promise((resolve) => {
       chrome.tabs.sendMessage(
         ${tabId},
         { target: 'qa-overlay', kind: 'move', x: 200, y: 150, caption: 'Clicking the "Go" button' },
         () => { void chrome.runtime.lastError; resolve(); },
       );
     });
     return true;
   })()`;

  let cursorPresent = false;
  for (let i = 0; i < 25 && !cursorPresent; i++) {
    await evalIn(sw, sendMove);
    await sleep(150);
    cursorPresent = await evalIn<boolean>(
      page,
      `!!document.getElementById('__qa_ghost_cursor__')`,
    );
    if (!cursorPresent) await sleep(150);
  }
  assert('cursor element exists after move', cursorPresent);

  const caption = await evalIn<string>(
    page,
    `(document.getElementById('__qa_ghost_caption__') || {}).textContent || ''`,
  );
  assert(
    'caption bar text matches',
    caption === 'Clicking the "Go" button',
    JSON.stringify(caption),
  );

  // The cursor should have transformed toward (200,150).
  const cursorTransform = await evalIn<string>(
    page,
    `(document.getElementById('__qa_ghost_cursor__') || {}).style ?
       document.getElementById('__qa_ghost_cursor__').style.transform : ''`,
  );
  assert(
    'cursor moved to target',
    cursorTransform.includes('200px') && cursorTransform.includes('150px'),
    cursorTransform,
  );

  // Send a click → a ripple ring should appear.
  await evalIn(
    sw,
    `(async () => {
       await new Promise((resolve) => {
         chrome.tabs.sendMessage(
           ${tabId},
           { target: 'qa-overlay', kind: 'click', x: 200, y: 150 },
           () => { void chrome.runtime.lastError; resolve(); },
         );
       });
       return true;
     })()`,
  );
  await sleep(100);
  const rippleCount = await evalIn<number>(
    page,
    `document.querySelectorAll('.__qa_ripple_ring').length`,
  );
  assert('ripple element appeared after click', rippleCount >= 1, `count=${rippleCount}`);

  // Send a caption-only event with ok=true → ✓ prefix.
  await evalIn(
    sw,
    `(async () => {
       await new Promise((resolve) => {
         chrome.tabs.sendMessage(
           ${tabId},
           { target: 'qa-overlay', kind: 'caption', caption: 'Assertion passed', ok: true },
           () => { void chrome.runtime.lastError; resolve(); },
         );
       });
       return true;
     })()`,
  );
  await sleep(100);
  const okCaption = await evalIn<string>(
    page,
    `(document.getElementById('__qa_ghost_caption__') || {}).textContent || ''`,
  );
  assert('caption ok-tick rendered', okCaption.startsWith('✓'), JSON.stringify(okCaption));

  // Visual proof.
  const shotPath = path.join(ARTIFACTS, 'overlay-proof.png');
  const { data } = await page.Page.captureScreenshot({ format: 'png' });
  fs.writeFileSync(shotPath, Buffer.from(data, 'base64'));
  assert('screenshot captured', fs.existsSync(shotPath), shotPath);
  console.log('screenshot:', shotPath);

  await sw.close();
  await page.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
} catch (e) {
  console.error('V8 FAILED:', e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
} finally {
  if (server) {
    try { server.close(); } catch { /* noop */ }
  }
  if (chrome) {
    try { chrome.kill(); } catch { /* gone */ }
  }
}
