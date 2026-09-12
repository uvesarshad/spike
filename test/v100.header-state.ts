/* v100 — header state and the messages around a run (A20).
 *
 * The panel used to show a grey/red "not connected" dot forever to the majority
 * who never install the desktop helper, explain nothing about Chrome's
 * "started debugging this browser" bar, report dismissing that bar as "Chrome's
 * debugging session was closed", and show a "Site map" card whose only possible
 * content was an instruction to open a terminal.
 *
 * extension/panel.* are MV3 sources that can't be imported (they need a DOM and
 * chrome.*), so — as in v74/v83 — string assertions cover what is only
 * reachable through the DOM and the pure helper is sliced out and run for real.
 *
 * Covers:
 *   1. a neutral "Lite" chip until a helper has EVER connected; the dot after
 *   2. the softened update note
 *   3. the debugging-bar note, first three tests only
 *   4. the detach error, in the user's words, with a way to start over
 *   5. the site map card is gone without a healthy helper
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
const html = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'panel.html'), 'utf8');
const css = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'panel.css'), 'utf8');
const panelSrc = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'panel.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'sw.js'), 'utf8');

/** Slice one top-level `function name(...) { ... }` out of a source file. */
function sliceFunction(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// ---- 1. the Lite chip -------------------------------------------------------
{
  check('there is a neutral chip in the header', html.includes('id="liteChip"'));
  check(
    'its tooltip is the agreed sentence',
    html.includes('Testing with your AI key. Spike Core is an optional desktop helper that adds auto-fix and video clips.'),
  );
  check('the chip reads "Lite"', />Lite</.test(html));
  check('the status dot starts hidden', /id="bridgeDot"[^>]*hidden/.test(html));
  check('the chip has its own styling', css.includes('.lite-chip'));
  check('the dot appears once a helper has ever been seen', /const showDot = connected \|\| helperSeen;/.test(panelSrc));
  check('"ever seen" outlives this panel', panelSrc.includes("const HELPER_SEEN_KEY = 'spikeHelperSeen'"));
  check('no dot tooltip says "daemon"', !/bridgeDot\.title[\s\S]{0,200}[Dd]aemon/.test(panelSrc));
}

// ---- 2. the update note -----------------------------------------------------
{
  check('the update note is softened', html.includes('Spike Core needs an update — tap for the command.'));
  check("...and no longer says the app can't run tests reliably", !html.includes("can't run tests reliably"));
}

// ---- 3. the debugging-bar note ---------------------------------------------
{
  check('there is a note under the Run button', html.includes('id="debugBarNote"'));
  check(
    'it explains Chrome\'s bar in Chrome\'s own words',
    html.includes('Chrome will show a "Spike started debugging this browser" bar while the test runs — leave it open.'),
  );
  check('it is shown for the first three tests only', panelSrc.includes('const DEBUG_BAR_NOTE_RUNS = 3;'));

  // the real gate, run against a stub element
  const fn = new Function(
    'state',
    `${sliceFunction(panelSrc, 'refreshDebugBarNote')}
     const debugBarNote = state.el;
     let runCount = state.runCount;
     const DEBUG_BAR_NOTE_RUNS = 3;
     refreshDebugBarNote();
     return state.el.hidden;`,
  );
  const at = (n: number) => fn({ el: { hidden: null }, runCount: n }) as boolean;
  check('shown on the first test', at(0) === false);
  check('still shown on the third', at(2) === false);
  check('gone by the fourth', at(3) === true);
  check('a started test is counted', /noteRunStarted\(\);/.test(panelSrc));
}

// ---- 4. the detach error ----------------------------------------------------
{
  check(
    'the detach error is in the user\'s words',
    panelSrc.includes("The test stopped because Chrome's debugging bar was closed. Run again."),
  );
  check('...and offers to start over', /showDebugBarClosed[\s\S]{0,300}label: 'Run again'/.test(panelSrc));

  const detect = new Function(
    'message',
    `${sliceFunction(panelSrc, 'isDebuggerBarClosed')} return isDebuggerBarClosed(message);`,
  ) as (m: unknown) => boolean;
  check('it recognises the helper\'s detach reason', detect("Chrome's debugging session was closed"));
  check('...and the browser-only path\'s (same sentence)', swSrc.includes('"Chrome\'s debugging session was closed"'));
  check('an ordinary failure is not mistaken for it', !detect('The order button threw an error'));
  check('nothing else is', !detect(undefined) && !detect(''));
}

// ---- 5. the site map card ---------------------------------------------------
{
  check('the site map card starts hidden', /id="siteMapSection"[^>]*hidden/.test(html));
  check(
    'it is shown only while the helper is healthy',
    /function renderSiteMapCard\(\)[\s\S]{0,400}siteMapSection\.hidden = !bridgeHealthy\(\)/.test(panelSrc),
  );
  check('a helper connecting or leaving re-decides it', /requestSavedTests\(true\);[\s\S]{0,200}renderSiteMapCard\(\);/.test(panelSrc));
}

// ---- summary ---------------------------------------------------------------
const failed = checks.filter(([, ok]) => !ok);
console.log(`\nv100: ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.error(`FAILED: ${failed.map(([l]) => l).join(', ')}`);
  process.exit(1);
}
