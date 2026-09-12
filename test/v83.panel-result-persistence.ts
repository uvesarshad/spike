/* v83 — the result survives the panel being closed (A10).
 *
 * Before this, a verdict reached the UI only as a live message to an open side
 * panel: close the panel to watch the page (the natural thing to do while a
 * test runs) and the verdict, the fix prompt and the "recent tests" row were
 * gone when it was reopened. The service worker now keeps the finished payload
 * per tab in session storage, replays it to a panel that connects or asks for
 * status, and writes the history row itself so it never depends on an open
 * port.
 *
 * extension/sw.js is an MV3 module that can't be imported here (it needs
 * chrome.* and a static ./lite-engine.js), so this suite does what v34/v74 do:
 * it reads the SHIPPED source, slices the real block out and runs it against
 * stubs. String assertions cover the parts only reachable through the DOM.
 *
 * Covers:
 *   1. a finished run is stored under its tab id, with only a small note about
 *      the report (screenshots must never reach storage)
 *   2. the history row is written by the worker, redacted and capped
 *   3. a connecting/polling panel gets the result back, once — not on every
 *      3-second poll — and never on top of a run that is in flight
 *   4. a new run on the same tab drops the stale verdict
 *   5. the wiring: replay on panel connect and on status; the panel renders a
 *      restored result and no longer writes history itself
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const swSrc = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'sw.js'), 'utf8');
const panelSrc = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'panel.js'), 'utf8');

// ---- harness: run the real A10 block against stubs -------------------------

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

const region = sliceRegion(swSrc, 'const LAST_RESULT_KEY', 'replayLastResult');

interface Deps {
  local: Record<string, unknown>;
  session: Record<string, unknown>;
  broadcasts: Record<string, unknown>[];
  chrome: unknown;
}

interface Api {
  rememberRunResult(tabId: unknown, done: unknown, extra?: unknown): Promise<void>;
  replayLastResult(port: unknown, tabId: unknown): Promise<void>;
  forgetRunResult(tabId: unknown): Promise<void>;
  redactTaskText(task: string): string;
  setBusy(v: boolean): void;
  setLastRunTabId(v: number | null): void;
}

function makeApi(deps: Deps): Api {
  const prologue = `
    let liteBusy = false;
    let lastRunTabId = null;
    const chrome = deps.chrome;
    const storageGet = (k) => Promise.resolve(deps.local[k]);
    const storageSet = (o) => { Object.assign(deps.local, o); return Promise.resolve(); };
    const sessionGet = (k) => Promise.resolve(deps.session[k]);
    const sessionSet = (o) => { Object.assign(deps.session, o); return Promise.resolve(); };
    const broadcastToPanels = (m) => { deps.broadcasts.push(m); };
  `;
  const epilogue = `
    return {
      rememberRunResult, replayLastResult, forgetRunResult, redactTaskText,
      setBusy: (v) => { liteBusy = v; },
      setLastRunTabId: (v) => { lastRunTabId = v; },
    };
  `;
  // eslint-disable-next-line no-new-func
  return new Function('deps', prologue + region + epilogue)(deps) as Api;
}

function freshDeps(activeTab: number | null = 7): Deps {
  return {
    local: {},
    session: {},
    broadcasts: [],
    chrome: {
      runtime: { lastError: undefined },
      tabs: { query: (_q: unknown, cb: (t: unknown[]) => void) => cb(activeTab === null ? [] : [{ id: activeTab }]) },
    },
  };
}

const DONE = {
  verdict: 'fail',
  plainReport: 'The order button did nothing.',
  fixPrompt: 'Fix the checkout button.',
  durationMs: 12_000,
};
const BUNDLE = {
  runId: '2026-09-13_10-00-00-abcd',
  reportJson: '{"verdict":"fail"}',
  screenshots: [{ name: 'screenshots/step-01.png', base64: 'AAAABBBBCCCC' }],
  audit: [],
};

function messagesTo(port: { sent: Record<string, unknown>[] }) {
  return port.sent;
}
function makePort() {
  const sent: Record<string, unknown>[] = [];
  return { sent, postMessage: (m: Record<string, unknown>) => sent.push(m) };
}

// ---- 1. the finished run is stored, without the screenshots -----------------
{
  const deps = freshDeps();
  const api = makeApi(deps);
  await api.rememberRunResult(7, DONE, { task: 'buy a widget', bundle: BUNDLE });

  const stored = deps.session['spikeLastResult'] as Record<string, any>;
  check('the finished run is stored under its tab id', !!(stored && stored['7'] && stored['7'].done));
  check('...with the verdict the panel renders', stored?.['7']?.done?.verdict === 'fail');
  check('...and the fix prompt', stored?.['7']?.done?.fixPrompt === 'Fix the checkout button.');
  check('...and what the user asked for', stored?.['7']?.task === 'buy a widget');
  check(
    '...with only a small note about the report',
    stored?.['7']?.bundle?.screenshotCount === 1 && stored?.['7']?.bundle?.runId === BUNDLE.runId,
  );
  check(
    'no screenshot data is ever put in storage',
    !JSON.stringify(deps.session).includes('AAAABBBBCCCC'),
  );
}

// ---- 2. the history row is written by the worker ----------------------------
{
  const deps = freshDeps();
  const api = makeApi(deps);
  await api.rememberRunResult(7, DONE, { task: 'log in with me@x.com / hunter2', bundle: BUNDLE });

  const list = deps.local['qaHistory'] as any[];
  check('the worker writes the recent-tests row itself', Array.isArray(list) && list.length === 1);
  check('...carrying the verdict', list?.[0]?.verdict === 'fail');
  check('...with a typed-in password trimmed out of it', !String(list?.[0]?.task || '').includes('hunter2'));
  check('...and handed to any open panel', deps.broadcasts.some((m) => m.kind === 'history'));

  // a run that ends with nobody listening still lands in the list
  for (let i = 0; i < 12; i++) await api.rememberRunResult(7, { verdict: 'pass' }, { task: `run ${i}` });
  const capped = deps.local['qaHistory'] as any[];
  check('the list is capped at ten rows', capped.length === 10);
  check('...newest first', capped[0].task === 'run 11');
}

// ---- 3. the panel gets it back — once ---------------------------------------
{
  const deps = freshDeps();
  const api = makeApi(deps);
  await api.rememberRunResult(7, DONE, { task: 'buy a widget', bundle: BUNDLE });

  const port = makePort();
  await api.replayLastResult(port, 7);
  const first = messagesTo(port)[0] as any;
  check('a reopened panel is handed the last result', first?.kind === 'done');
  check('...flagged as one it missed', first?.restored === true);
  check('...with the verdict and fix prompt intact', first?.verdict === 'fail' && !!first?.fixPrompt);
  check('...and the task, so it can be run again', first?.task === 'buy a widget');

  await api.replayLastResult(port, 7);
  check('asking again does not re-show the same result', messagesTo(port).length === 1);

  await api.rememberRunResult(7, { verdict: 'pass', plainReport: 'All good.' }, { task: 'buy a widget' });
  await api.replayLastResult(port, 7);
  check('a newer result IS shown', (messagesTo(port)[1] as any)?.verdict === 'pass');
}

// ---- 3b. the tab, and running tests ----------------------------------------
{
  const deps = freshDeps(7); // the panel is looking at tab 7
  const api = makeApi(deps);
  await api.rememberRunResult(7, DONE, { task: 'buy a widget' });

  const port = makePort();
  await api.replayLastResult(port, null); // panel connected without saying which tab
  check('without a tab id, the tab in front of the user is used', messagesTo(port).length === 1);

  const other = makePort();
  await api.replayLastResult(other, 99);
  check('a tab that never ran anything gets nothing', messagesTo(other).length === 0);

  const busyPort = makePort();
  api.setBusy(true);
  await api.replayLastResult(busyPort, 7);
  check('a result is never replayed over a test that is running', messagesTo(busyPort).length === 0);
  api.setBusy(false);
}

// ---- 4. a new run drops the stale verdict -----------------------------------
{
  const deps = freshDeps();
  const api = makeApi(deps);
  await api.rememberRunResult(7, DONE, { task: 'buy a widget' });
  await api.forgetRunResult(7);
  const port = makePort();
  await api.replayLastResult(port, 7);
  check('starting a new test clears the old verdict for that tab', messagesTo(port).length === 0);
}

// ---- 5. the wiring ----------------------------------------------------------
{
  check(
    'a panel connecting is caught up straight away',
    /panelPorts\.add\(port\);[\s\S]{0,400}replayLastResult\(port, null\)/.test(swSrc),
  );
  check(
    'so is one asking how things stand',
    /case 'status': \{[\s\S]{0,400}replayLastResult\(port, typeof msg\.tabId === 'number'/.test(swSrc),
  );
  check(
    'the run result is saved before it is broadcast',
    swSrc.indexOf('await rememberRunResult(tabId, result.done') <
      swSrc.indexOf("broadcastToPanels({ kind: 'done', ...result.done })"),
  );
  check(
    'a result from the desktop helper is saved too',
    swSrc.includes("if (event === 'vibe.done') {") && swSrc.includes('void rememberRunResult(lastRunTabId'),
  );

  check('the panel no longer writes the recent-tests list', !panelSrc.includes('saveHistory('));
  check('the panel takes the list the worker hands it', /case 'history':/.test(panelSrc));
  check(
    'a restored result never overwrites a running test',
    /if \(msg\.restored && busy\) break;/.test(panelSrc),
  );
  check(
    'the panel says a restored result is from the last test',
    panelSrc.includes('it finished while this panel was closed'),
  );
  check('the panel tells the worker which tab it is on', /kind: 'status', tabId:/.test(panelSrc));

  // the vocabulary rule for anything the user reads
  const restoredLine = 'This is the result of your last test — it finished while this panel was closed.';
  const jargon = ['daemon', 'CDP', 'service worker', 'session storage', 'tabId'];
  check(
    'the restored-result line is plain English',
    jargon.every((w) => !restoredLine.toLowerCase().includes(w.toLowerCase())),
  );
}

// ---- 6. a test Chrome interrupted is rendered, not swallowed ---------------
{
  // the worker has always computed this and put it in every status reply; the
  // panel read only `busy` and dropped it on the floor
  check(
    'the panel acts on an interrupted test',
    /if \(!msg\.busy && msg\.orphanedRun\) showInterruptedRun\(msg\.orphanedRun\)/.test(panelSrc),
  );
  const SENTENCE = 'Your last test stopped when Chrome put the extension to sleep — run it again.';
  check('...with the plain sentence', panelSrc.includes(SENTENCE));
  check("...and a way to start over", /label: 'Run again'/.test(panelSrc));
  check(
    '...that actually starts the test',
    /label: 'Run again',[\s\S]{0,200}startRun\(taskInput\.value\)/.test(panelSrc),
  );
  check(
    '...only once, not on every poll',
    panelSrc.includes('interruptedRunShown === id'),
  );
  check(
    'the task from the interrupted test is put back in the box',
    /if \(task && !\(taskInput\.value \|\| ''\)\.trim\(\)\) taskInput\.value = task;/.test(panelSrc),
  );

  const jargon = ['service worker', 'evicted', 'orphan', 'MV3', 'daemon', 'runId'];
  check(
    'the interrupted-test sentence is plain English',
    jargon.every((w) => !SENTENCE.toLowerCase().includes(w.toLowerCase())),
  );
}

// ---- 7. the panel keeps asking while a test is running ----------------------
{
  const tail = panelSrc.slice(panelSrc.indexOf('// poll the bridge connection'));
  check('the few-second poll also asks how the test is doing', /if \(busy\) postToSW\(\{ kind: 'status'/.test(tail));
  check('...only while one is running', tail.indexOf('if (busy)') > tail.indexOf("kind: 'bridge-status'"));
  check(
    'the "already running" line is printed on the transition, not every poll',
    /if \(msg\.busy && !wasBusy\) addProgressLine/.test(panelSrc),
  );
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v83 checks passed`);
process.exit(failed.length ? 1 : 0);
