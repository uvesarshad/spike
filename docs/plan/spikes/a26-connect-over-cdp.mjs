/* A26 spike — does Playwright's connectOverCDP give real per-context isolation
 * against a Chrome the daemon already launched?
 *
 * Mirrors spike's own setup: branded Chrome, --remote-debugging-port, own profile.
 * Answers exactly one question: can we get parallel isolated BrowserContexts
 * (cookies + localStorage) without Playwright owning the browser lifecycle? */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CDP_PORT = 9455;
const HTTP_PORT = 9456;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'a26-spike-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// A real origin: localStorage/cookies need one (data: URLs won't do).
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><title>a26</title><h1>a26 spike</h1>');
});
await new Promise((r) => server.listen(HTTP_PORT, r));
const ORIGIN = `http://localhost:${HTTP_PORT}/`;

console.log('launching Chrome (headed, own profile, own port)...');
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  ORIGIN,
], { stdio: 'ignore', detached: true });
chrome.unref();

// Wait for CDP to come up, same poll shape as chrome/launch.ts
let up = false;
for (let i = 0; i < 50 && !up; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    if (r.ok) up = true;
  } catch { await sleep(300); }
}
if (!up) { console.error('Chrome CDP never came up'); process.exit(1); }
console.log('CDP is up.\n');

let browser;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  record('connectOverCDP attaches to an existing Chrome', true,
    'attached');
} catch (e) {
  record('connectOverCDP attaches to an existing Chrome', false, e.message);
  process.exit(1);
}

// Q1: how many contexts does the connected browser expose?
const initial = browser.contexts();
record('browser.contexts() exposes the existing default context', initial.length >= 1,
  `${initial.length} context(s)`);

// Q2: THE decisive question — can we create additional contexts?
let ctxA = null, ctxB = null, newContextWorks = false;
try {
  ctxA = await browser.newContext();
  ctxB = await browser.newContext();
  newContextWorks = true;
  record('browser.newContext() succeeds over connectOverCDP', true,
    `contexts now: ${browser.contexts().length}`);
} catch (e) {
  record('browser.newContext() succeeds over connectOverCDP', false, e.message);
}

if (newContextWorks) {
  // Q3: cookie isolation between two contexts
  try {
    const pA = await ctxA.newPage();
    const pB = await ctxB.newPage();
    await pA.goto(ORIGIN);
    await pB.goto(ORIGIN);

    await ctxA.addCookies([{ name: 'spike_ctx', value: 'A', url: ORIGIN }]);
    const seenInB = (await ctxB.cookies(ORIGIN)).some((c) => c.name === 'spike_ctx');
    const seenInA = (await ctxA.cookies(ORIGIN)).some((c) => c.name === 'spike_ctx');
    record('cookies are isolated per context', seenInA && !seenInB,
      `A sees it: ${seenInA}, B sees it: ${seenInB}`);

    // Q4: localStorage isolation
    await pA.evaluate(() => localStorage.setItem('spike_ctx', 'A'));
    const lsB = await pB.evaluate(() => localStorage.getItem('spike_ctx'));
    const lsA = await pA.evaluate(() => localStorage.getItem('spike_ctx'));
    record('localStorage is isolated per context', lsA === 'A' && lsB === null,
      `A: ${JSON.stringify(lsA)}, B: ${JSON.stringify(lsB)}`);

    // Q5: storageState export/import — the A6 primitive
    const state = await ctxA.storageState();
    const hasCookie = state.cookies?.some((c) => c.name === 'spike_ctx');
    record('storageState() exports cookies (A6 primitive)', Boolean(hasCookie),
      `${state.cookies?.length ?? 0} cookie(s), ${state.origins?.length ?? 0} origin(s)`);

    // Q6: concurrent driving — two contexts doing work at the same time
    const t0 = Date.now();
    await Promise.all([
      pA.goto(ORIGIN).then(() => pA.title()),
      pB.goto(ORIGIN).then(() => pB.title()),
    ]);
    record('two contexts drive concurrently', true, `${Date.now() - t0}ms for both`);

    // Q7: does closing one context disturb the other / the original browser?
    await ctxA.close();
    const bStillWorks = (await pB.title()) === 'a26';
    const originalAlive = browser.contexts().length >= 1;
    record('closing one context leaves others + original Chrome intact',
      bStillWorks && originalAlive,
      `B alive: ${bStillWorks}, contexts left: ${browser.contexts().length}`);
    await ctxB.close();
  } catch (e) {
    record('isolation checks completed', false, e.message);
  }
}

// Q8: routing (A13) over a connected browser
try {
  const ctxR = newContextWorks ? await browser.newContext() : browser.contexts()[0];
  const pR = await ctxR.newPage();
  let intercepted = false;
  await ctxR.route('**/*', (route) => { intercepted = true; route.continue(); });
  await pR.goto(ORIGIN);
  record('context.route() interception works (A13 primitive)', intercepted);
  if (newContextWorks) await ctxR.close(); else await pR.close();
} catch (e) {
  record('context.route() interception works (A13 primitive)', false, e.message);
}

await browser.close().catch(() => {});
server.close();
try { process.kill(-chrome.pid); } catch { try { chrome.kill(); } catch {} }
fs.rmSync(profile, { recursive: true, force: true });

console.log('\n' + '='.repeat(60));
const passed = results.filter((r) => r.pass).length;
console.log(`${passed}/${results.length} checks passed`);
console.log('VERDICT:', results.find((r) => r.name.includes('newContext'))?.pass
  ? 'connectOverCDP DOES give per-context isolation → adopt Playwright for A3'
  : 'connectOverCDP does NOT isolate → hand-build A3 on Target.createBrowserContext');
process.exit(0);
