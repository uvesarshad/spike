/* v16 — does an active Page.startScreencast break Input.dispatchMouseEvent
 * after a cross-document navigation? (Suspected from a live v10 failure:
 * post-navigation Add-to-cart clicks no-op'd only when the clip recorder ran.)
 *
 * Scripted, no AI: fixture login → products, click "Add Widget to cart" twice,
 * read the cart counter — once WITHOUT screencast, once WITH. Headless AND
 * headed variants, because screencast behavior differs by visibility. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CdpBrowser } from '../src/ports/cdp-browser.js';
import type { AxNode } from '../src/ports/browser-port.js';
import { startClipRecorder } from '../src/clip/screencast.js';
import { ArtifactStore } from '../src/report/artifacts.js';
import { startFixture, stopFixture } from '../fixture/server.js';

const PORT = 9407;
const CDP_PORT = 9337;

function find(root: AxNode, role: string, nameIncludes: string): AxNode | undefined {
  if (root.role === role && root.name?.toLowerCase().includes(nameIncludes.toLowerCase())) return root;
  for (const c of root.children ?? []) {
    const hit = find(c, role, nameIncludes);
    if (hit) return hit;
  }
  return undefined;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function clickByName(browser: CdpBrowser, role: string, name: string): Promise<void> {
  const ax = await browser.axTree();
  const node = find(ax.root, role, name);
  if (!node) throw new Error(`${role} "${name}" not found`);
  await browser.click(node.id);
  await sleep(400);
}

async function typeByName(browser: CdpBrowser, name: string, text: string): Promise<void> {
  const ax = await browser.axTree();
  const node = find(ax.root, 'textbox', name);
  if (!node) throw new Error(`textbox "${name}" not found`);
  await browser.type(node.id, text);
}

async function cartCountAfterClicks(headless: boolean, withClip: boolean): Promise<string> {
  const browser = new CdpBrowser({
    port: CDP_PORT,
    profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'qa-v16-')),
    headless,
  });
  await browser.launch();
  try {
    const clip = withClip ? await startClipRecorder(browser.cdpClient() as Parameters<typeof startClipRecorder>[0], new ArtifactStore('artifacts')) : null;
    await browser.navigate(`http://localhost:${PORT}/login`);
    await typeByName(browser, 'Email', 'test@test.com');
    await typeByName(browser, 'Password', 'pw');
    await clickByName(browser, 'button', 'Sign in'); // navigates → /products
    await sleep(400);
    await clickByName(browser, 'button', 'Add Widget');
    await clickByName(browser, 'button', 'Add Widget');
    const ax = await browser.axTree();
    if (clip) await clip.stop().catch(() => null);
    // the page shows "Cart: N items"
    const m = ax.text.match(/Cart: (\d+) items/);
    return m ? m[1] : `no-cart-text (${ax.text.slice(0, 120)})`;
  } finally {
    await browser.close();
    // kill this throwaway chrome so the next variant starts fresh
    const { spawnSync } = await import('node:child_process');
    spawnSync('powershell', ['-Command', `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match 'remote-debugging-port=${CDP_PORT}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore' });
    await sleep(800);
  }
}

const fixture = startFixture(PORT, false);
const results: Record<string, string> = {};
try {
  for (const headless of [true, false]) {
    for (const withClip of [false, true]) {
      const key = `${headless ? 'headless' : 'headed'} clip=${withClip}`;
      results[key] = await cartCountAfterClicks(headless, withClip);
      console.log(`${key}: cart=${results[key]}`);
    }
  }
} finally {
  await stopFixture(fixture);
}

const broken = Object.entries(results).filter(([, v]) => v !== '2');
console.log(broken.length ? `\nBROKEN variants: ${broken.map(([k, v]) => `${k} → ${v}`).join('; ')}` : '\nall variants: clicks work (cart=2)');
process.exit(0); // diagnostic — always exit 0, the output is the answer
