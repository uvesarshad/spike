/* v99 — panel runs become saved tests, and saved tests are re-runnable (A19).
 *
 * Before this, a run started from the side panel set `record: false`, so the
 * panel could only ever pay for a fresh AI pass: it CONSUMED saved tests (the
 * pre-run matcher) but never produced one. There was no way to see, re-run or
 * repair a saved test from the panel, and a "recent runs" row kept 120
 * characters of the reason and, when clicked, started a brand-new paid run.
 *
 * The service is real TypeScript and is exercised through its bridge methods
 * against a stub BridgeServer + a temp generated-tests/ directory. The MV3
 * sources (panel.js / sw.js) can't be imported, so — as in v74/v83 — the real
 * blocks are sliced out of the shipped files and run against stubs.
 *
 * Covers:
 *   1. a panel run records a saved test, as a terminal run does
 *   2. vibe.tests.list: this site's saved tests, newest first, www-tolerant
 *   3. vibe.replay: authenticated, single-run locked, name-validated
 *   4. the history row keeps the whole report (and the whole reason), redacted
 *      and without a megabyte of screenshot
 *   5. the panel wiring: a Saved tests card gated on the helper, "Run again
 *      (free)" / "Repair", and a history click that re-shows the result
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VibeService } from '../src/vibe/service.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const swSrc = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'sw.js'), 'utf8');
const panelSrc = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'panel.js'), 'utf8');
const panelHtml = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'panel.html'), 'utf8');
const serviceSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'vibe', 'service.ts'), 'utf8');

// ---- 1. a panel run is recorded ---------------------------------------------
{
  // the option the panel path hands the engine, read straight out of the source
  const runOpts = serviceSrc.slice(serviceSrc.indexOf('const runOpts = {'), serviceSrc.indexOf('const report = await qaRun('));
  check('a panel run asks the engine to record it', /record: true,/.test(runOpts));
  check('no panel run is left unrecorded', !/record: false/.test(serviceSrc));
}

// ---- 2/3. the two new bridge methods ----------------------------------------
type Handler = (params: unknown, ctx: { clientId: number }) => Promise<unknown>;

class StubBridge {
  handlers = new Map<string, Handler>();
  events: Array<{ name: string; params: unknown }> = [];
  authed = true;
  onRequest(name: string, fn: Handler) { this.handlers.set(name, fn); }
  onEvent() { /* the detach listener — not exercised here */ }
  isAuthenticated() { return this.authed; }
  sendEvent(name: string, params: unknown) { this.events.push({ name, params }); }
  call() { return Promise.resolve({ ok: false }); }
  invoke(name: string, params: unknown) {
    const fn = this.handlers.get(name);
    if (!fn) throw new Error(`no handler for ${name}`);
    return fn(params, { clientId: 1 });
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-v99-'));
const scriptsDir = path.join(tmp, 'generated-tests');
fs.mkdirSync(scriptsDir, { recursive: true });

function writeScript(name: string, url: string, createdAt: string, steps = 3): void {
  fs.writeFileSync(
    path.join(scriptsDir, `${name}.json`),
    JSON.stringify({
      version: 1,
      name,
      task: `do ${name}`,
      url,
      sourceRunId: 'run-1',
      createdAt,
      steps: Array.from({ length: steps }, () => ({ type: 'navigate', url })),
    }),
  );
}

writeScript('checkout', 'https://shop.example.com/cart', '2026-09-10T10:00:00.000Z');
writeScript('signup', 'https://www.shop.example.com/signup', '2026-09-12T10:00:00.000Z');
writeScript('other-site', 'https://other.example.org/', '2026-09-11T10:00:00.000Z');
fs.writeFileSync(path.join(scriptsDir, 'broken.json'), '{ not json');

const bridge = new StubBridge();
const service = new VibeService(bridge as never);
service.start();

const cwd = process.cwd();
process.chdir(tmp);
try {
  const all = (await bridge.invoke('vibe.tests.list', {})) as { tests: Array<Record<string, unknown>> };
  check('every saved test is listed when no site is named', all.tests.length === 3);
  check('a malformed saved test is skipped, not fatal', !all.tests.some((t) => t.name === 'broken'));
  check('newest first', String(all.tests[0].name) === 'signup');
  check('a saved test reports how many steps it has', all.tests.every((t) => typeof t.steps === 'number'));

  const scoped = (await bridge.invoke('vibe.tests.list', { host: 'shop.example.com' })) as {
    tests: Array<Record<string, unknown>>;
  };
  check('a site only sees its own saved tests', scoped.tests.length === 2);
  check('...and www. counts as the same site', scoped.tests.some((t) => t.name === 'signup'));
  check('...while another site is excluded', !scoped.tests.some((t) => t.name === 'other-site'));

  // ---- vibe.replay guards (nothing here should ever reach a browser) -------
  let refused = '';
  try { await bridge.invoke('vibe.replay', {}); } catch (e) { refused = String(e); }
  check('replay needs a test name', /requires \{ name \}/.test(refused));

  refused = '';
  try { await bridge.invoke('vibe.replay', { name: '../../etc/passwd' }); } catch (e) { refused = String(e); }
  check('replay refuses a name that is really a path', /invalid test name/.test(refused));

  bridge.authed = false;
  refused = '';
  try { await bridge.invoke('vibe.replay', { name: 'checkout' }); } catch (e) { refused = String(e); }
  check('replay refuses an unpaired caller', /unauthenticated/.test(refused));
  bridge.authed = true;

  check(
    'replay takes the same single-run lock a fresh test does',
    /vibe\.replay[\s\S]{0,900}if \(this\.busy\) throw new Error\('a run is already in progress'\)/.test(serviceSrc),
  );
} finally {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- 4. the history row keeps the whole result -----------------------------
/** Slice from `startMarker` to the closing brace of `async function endFn`. */
function sliceRegion(src: string, startMarker: string, endFn: string): string {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error(`marker ${startMarker} not found`);
  const fnStart = src.indexOf(`async function ${endFn}(`, start);
  if (fnStart < 0) throw new Error(`function ${endFn} not found`);
  const open = src.indexOf('{', fnStart);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${endFn}`);
}

{
  const region = sliceRegion(swSrc, 'const SECRET_PLACEHOLDER_RE', 'appendHistoryEntry');
  const local: Record<string, unknown> = {};
  const broadcasts: Record<string, unknown>[] = [];
  const api = new Function(
    'deps',
    `
    const storageGet = (k) => Promise.resolve(deps.local[k]);
    const storageSet = (o) => { Object.assign(deps.local, o); return Promise.resolve(); };
    const broadcastToPanels = (m) => { deps.broadcasts.push(m); };
    const HISTORY_STORAGE_KEY = 'qaHistory';
    const HISTORY_CAP = 10;
    ${region}
    return { appendHistoryEntry };
  `,
  )({ local, broadcasts }) as { appendHistoryEntry(task: string, done: unknown): Promise<unknown[]> };

  const longReason = 'The Place order button threw an error. '.repeat(12);
  await api.appendHistoryEntry('log in with me@x.com / hunter2', {
    verdict: 'fail',
    reason: 'order.total is undefined',
    plainReport: longReason,
    console_error: 'TypeError: order.total is undefined',
    failing_step: 4,
    reasonExplained: { headline: 'The order button is broken.', whoseFault: 'your app' },
    screenshotPath: '/artifacts/run-1/screenshots/step-04.png',
    durationMs: 9000,
    fixPrompt: `Fix it. ![shot](data:image/png;base64,${'A'.repeat(5000)})`,
  });

  const row = (local['qaHistory'] as Array<Record<string, any>>)[0];
  check('the history row is no longer clipped to 120 characters', String(row.reason).length > 120);
  check('the history row carries the whole result', !!row.report && row.report.verdict === 'fail');
  check('...including the translated headline', !!row.report.reasonExplained.headline);
  check('...and the failing step and console error', row.report.failing_step === 4 && !!row.report.console_error);
  check('...and the fix prompt', String(row.report.fixPrompt).startsWith('Fix it.'));
  check('an embedded screenshot never reaches storage', !String(row.report.fixPrompt).includes('base64,AAAA'));
  check('a password typed into the task box is still redacted', !JSON.stringify(row).includes('hunter2'));
}

// ---- 5. the panel wiring ----------------------------------------------------
{
  check('there is a Saved tests card', panelHtml.includes('id="savedTestsSection"'));
  check('it is hidden by default', /id="savedTestsSection"[^>]*hidden/.test(panelHtml));
  check('the card is gated on the desktop helper', /function renderSavedTests\(\)[\s\S]{0,260}bridgeHealthy\(\)/.test(panelSrc));
  check('re-running a saved test is offered as free', panelSrc.includes("'Run again (free)'"));
  check('repairing it is a separate button', /repair\.textContent = 'Repair'/.test(panelSrc));
  check('"Run again" replays, it does not start a fresh AI pass', /kind: 'replay'/.test(panelSrc));
  check('"Repair" asks for healing', /startSavedTest\(t, true\)/.test(panelSrc));
  check('the worker forwards the list request', panelSrc.includes("kind: 'tests-list'") && swSrc.includes("case 'tests-list'"));
  check('the worker forwards the replay request', swSrc.includes("sendRequest('vibe.replay'"));
  check(
    'with no helper there are simply no saved tests to show',
    /case 'tests-list'[\s\S]{0,400}daemonConnected\(\)[\s\S]{0,120}tests: \[\]/.test(swSrc),
  );
  check('clicking a past test re-shows its result', /if \(item\.report\) \{[\s\S]{0,200}renderResult\(/.test(panelSrc));
  check('...and says nothing was run', panelSrc.includes('Nothing was run'));
  check('...rather than re-filling the box first', /if \(item\.report\)[\s\S]{0,300}return;/.test(panelSrc));
  const jargon = ['daemon', 'CDP', 'BYOK', 'replay clip at $0'];
  for (const s of jargon) {
    const shown = new RegExp(`(textContent|title|placeholder)\\s*=\\s*['"\`][^'"\`]*${s}`, 'i').test(panelSrc);
    check(`no user-facing string in the saved-tests card says "${s}"`, !shown);
  }
}

// ---- summary ---------------------------------------------------------------
const failed = checks.filter(([, ok]) => !ok);
console.log(`\nv99: ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.error(`FAILED: ${failed.map(([l]) => l).join(', ')}`);
  process.exit(1);
}
