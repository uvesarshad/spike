/**
 * V53 — driver-loop hardening (26-08-27 market-readiness audit, A1/A2/A3/A6).
 * Pure unit coverage, no Chrome/model calls — stub BrowserPort + ModelRouter,
 * same style as test/v31.action-cache-driver.ts.
 *
 * Covers:
 *  - A1: strictOracles gates the final verdict on a failed deterministic
 *    assertion (assert_text) even when the model itself claims 'pass';
 *    strictOracles:false restores the pre-A1 evidence-only behavior.
 *  - A2: the navigator-only ($0, no plan-goals adapter) degrade path survives
 *    a `blocked` navigator turn and a per-goal step-budget overflow without
 *    ending the run early — it reaches the FULL maxSteps budget, not the old
 *    12-step per-goal cutoff.
 *  - A3: a mid-batch retry re-snapshot (executeWithRetry recovering from a
 *    stale nodeId) discards the REST of that batch instead of letting a later
 *    action resolve its nodeId against the rebuilt node map.
 *  - A6: an unguarded browser.axTree() throw mid-run still yields a
 *    persisted, evidence-bearing 'uncertain' report instead of a rejected
 *    promise.
 *
 * Run: npx tsx test/v53.driver-hardening.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDriverLoop } from '../src/driver/loop.js';
import { ArtifactStore } from '../src/report/artifacts.js';
import type { AxNode, AxSnapshot, BrowserPort, ConsoleEntry, NetworkEntry } from '../src/ports/browser-port.js';
import type { ModelRouter } from '../src/router/model-router.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-v53-'));

/** A stub navigator-only router: `hasCapability` always false (no plan-goals
 * adapter configured) so the loop degrades to the navigator-only path these
 * tests exercise; `planJson` serves queued responses in order; `visualVerdict`
 * always agrees with a claimed pass (the confirmation visual is not what
 * these tests are probing). */
function fakeRouter(planQueue: unknown[]) {
  let planCalls = 0;
  return {
    trace: [],
    get planCalls() {
      return planCalls;
    },
    async hasCapability(): Promise<boolean> {
      return false;
    },
    async planJson(): Promise<unknown> {
      planCalls++;
      const next = planQueue.shift();
      assert.ok(next, 'expected queued navigator plan');
      return next;
    },
    async visualVerdict(): Promise<unknown> {
      return { verdict: 'pass', summary: 'ok', issues: [] };
    },
  } as unknown as ModelRouter & { planCalls: number };
}

// ---------------------------------------------------------------------------
// A1 — strictOracles gates a failed deterministic assertion
// ---------------------------------------------------------------------------

class SimpleBrowser implements BrowserPort {
  private currentUrl = 'http://localhost/simple';
  axTreeShouldThrowOnCall: number | null = null;
  private axTreeCalls = 0;

  async launch(): Promise<void> {}
  async navigate(u: string): Promise<void> {
    this.currentUrl = u;
  }
  async url(): Promise<string> {
    return this.currentUrl;
  }
  async axTree(): Promise<AxSnapshot> {
    this.axTreeCalls++;
    if (this.axTreeShouldThrowOnCall !== null && this.axTreeCalls === this.axTreeShouldThrowOnCall) {
      throw new Error('simulated CDP disconnect');
    }
    const root: AxNode = {
      id: 'root',
      role: 'document',
      name: 'App',
      children: [{ id: 'n1', role: 'button', name: 'Submit' }],
    };
    // deliberately does NOT contain "Order confirmed" — the assert_text
    // failure A1's test relies on.
    return { root, text: 'document "App"\n  button "Submit"', truncated: false };
  }
  async click(): Promise<void> {}
  async type(): Promise<void> {}
  async hover(): Promise<void> {}
  async pressKey(): Promise<void> {}
  async selectOption(): Promise<void> {}
  async reload(): Promise<void> {}
  async goBack(): Promise<void> {}
  async uploadFile(): Promise<void> {}
  async dragAndDrop(): Promise<void> {}
  async blur(): Promise<void> {}
  async mouse(): Promise<void> {}
  async openTab(): Promise<string> {
    return 'tab-0';
  }
  async switchTab(): Promise<void> {}
  async closeTab(): Promise<void> {}
  async screenshot(): Promise<Buffer> {
    return Buffer.from('fake-png');
  }
  async setLogpoint(): Promise<void> {}
  drainConsole(): ConsoleEntry[] {
    return [];
  }
  drainNetwork(): NetworkEntry[] {
    return [];
  }
  async close(): Promise<void> {}
}

function assertTextThenFinishQueue(): unknown[] {
  return [
    { thought: 'check the order confirmation', actions: [{ type: 'assert_text', mode: 'contains', value: 'Order confirmed' }] },
    { thought: 'looks done', actions: [{ type: 'finish', verdict: 'pass', reason: 'assumed the order went through' }] },
  ];
}

{
  const a1Report = await runDriverLoop(
    new SimpleBrowser(),
    fakeRouter(assertTextThenFinishQueue()),
    new ArtifactStore(path.join(root, 'a1-on')),
    'place an order and confirm it',
    'http://localhost/simple',
    { maxSteps: 6, strictOracles: true },
  );
  check('A1: the assert_text step itself failed (page text lacks the expected string)', a1Report.steps[0]?.ok === false);
  check('A1: strictOracles:true forces the final verdict to fail despite the model claiming pass', a1Report.verdict === 'fail');
  check('A1: failing_step points at the failed assertion, not the model\'s finish step', a1Report.failing_step?.index === 0);
}

{
  const a1ReportOff = await runDriverLoop(
    new SimpleBrowser(),
    fakeRouter(assertTextThenFinishQueue()),
    new ArtifactStore(path.join(root, 'a1-off')),
    'place an order and confirm it',
    'http://localhost/simple',
    { maxSteps: 6, strictOracles: false },
  );
  check('A1: strictOracles:false leaves the model\'s own verdict standing (pass)', a1ReportOff.verdict === 'pass');
}

// ---------------------------------------------------------------------------
// A2 — navigator-only degrade path survives `blocked` + per-goal overflow
// ---------------------------------------------------------------------------

class NoopBrowser implements BrowserPort {
  private currentUrl = 'http://localhost/noop';
  async launch(): Promise<void> {}
  async navigate(u: string): Promise<void> {
    this.currentUrl = u;
  }
  async url(): Promise<string> {
    return this.currentUrl;
  }
  async axTree(): Promise<AxSnapshot> {
    const root: AxNode = { id: 'root', role: 'document', name: 'App', children: [{ id: 'n1', role: 'button', name: 'Go' }] };
    return { root, text: 'document "App"\n  button "Go"', truncated: false };
  }
  async click(): Promise<void> {}
  async type(): Promise<void> {}
  async hover(): Promise<void> {}
  async pressKey(): Promise<void> {}
  async selectOption(): Promise<void> {}
  async reload(): Promise<void> {}
  async goBack(): Promise<void> {}
  async uploadFile(): Promise<void> {}
  async dragAndDrop(): Promise<void> {}
  async blur(): Promise<void> {}
  async mouse(): Promise<void> {}
  async openTab(): Promise<string> {
    return 'tab-0';
  }
  async switchTab(): Promise<void> {}
  async closeTab(): Promise<void> {}
  async screenshot(): Promise<Buffer> {
    return Buffer.from('fake-png');
  }
  async setLogpoint(): Promise<void> {}
  drainConsole(): ConsoleEntry[] {
    return [];
  }
  drainNetwork(): NetworkEntry[] {
    return [];
  }
  async close(): Promise<void> {}
}

{
  // 2 actions/batch (never a 1-action batch, so the unrelated 3x-repeat
  // detector never fires) x 8 batches = 16 steps, with ONE `blocked` turn
  // interleaved and a per-goal overflow (default cap 12) crossed mid-run.
  // maxSteps=16 with the DEFAULT per-goal cap (min(maxSteps,12)=12): the
  // pre-A2 bug ended the run at the first blocked/overflow event, nowhere
  // near 16 steps.
  const batch = { thought: 'keep going', actions: [{ type: 'click', nodeId: 'n1' }, { type: 'hover', nodeId: 'n1' }] };
  const queue: unknown[] = [
    batch, batch, batch, // 6 steps
    { thought: 'stuck', blocked: 'a captcha appeared' }, // survives, no step
    batch, batch, batch, batch, // steps 6 -> 14, crosses the 12-step per-goal cap mid-way
    batch, // steps 14 -> 16 == maxSteps
  ];
  const a2Router = fakeRouter(queue);
  const a2Report = await runDriverLoop(
    new NoopBrowser(),
    a2Router,
    new ArtifactStore(path.join(root, 'a2')),
    'click around',
    'http://localhost/noop',
    { maxSteps: 16 },
  );
  check('A2: every queued navigator turn was consumed (9), not cut short at the blocked/overflow event', a2Router.planCalls === 9);
  check('A2: the run reached the FULL maxSteps budget (16), not the old 12-step per-goal cutoff', a2Report.steps.length === 16);
  check(
    'A2: the run ended honestly on step-budget exhaustion, not a premature "stuck" verdict',
    a2Report.verdict === 'uncertain' && a2Report.reason.includes('step budget exhausted'),
  );
}

// ---------------------------------------------------------------------------
// A3 — mid-batch node-map clobber discards the rest of the batch
// ---------------------------------------------------------------------------

class ClobberBrowser implements BrowserPort {
  private currentUrl = 'http://localhost/clobber';
  private snapshotCalls = 0;
  attemptedClicks: string[] = [];

  async launch(): Promise<void> {}
  async navigate(u: string): Promise<void> {
    this.currentUrl = u;
  }
  async url(): Promise<string> {
    return this.currentUrl;
  }
  async axTree(): Promise<AxSnapshot> {
    this.snapshotCalls++;
    if (this.snapshotCalls === 1) {
      // the batch's own snapshot: n1/n2
      const root: AxNode = {
        id: 'root',
        role: 'document',
        name: 'App',
        children: [
          { id: 'n1', role: 'button', name: 'Foo' },
          { id: 'n2', role: 'button', name: 'Bar' },
        ],
      };
      return { root, text: 'document "App"\n  button "Foo"\n  button "Bar"', truncated: false };
    }
    // EVERY later call (the retry's fresh re-snapshot, and the next outer
    // iteration's own batch snapshot) returns a REBUILT tree with different
    // ids — simulating the port's nodeId->backendDOMNodeId map being rebuilt
    // by every fresh Accessibility.getFullAXTree call.
    const root: AxNode = {
      id: 'root',
      role: 'document',
      name: 'App',
      children: [
        { id: 'm1', role: 'button', name: 'Foo' },
        { id: 'm2', role: 'button', name: 'Bar' },
      ],
    };
    return { root, text: 'document "App"\n  button "Foo"\n  button "Bar"', truncated: false };
  }
  async click(nodeId: string): Promise<void> {
    this.attemptedClicks.push(nodeId);
    // 'n1' (the batch snapshot's id for "Foo") always fails — this is what
    // drives executeWithRetry into its fresh-re-snapshot recovery path.
    // Anything else (the retry's resolved id, or a stale id from the
    // ORIGINAL snapshot the bug would have misdirected) "succeeds" — the
    // test's assertion is about WHICH ids get attempted, not whether they
    // throw.
    if (nodeId === 'n1') throw new Error('simulated stale node — detached before click');
  }
  async type(): Promise<void> {}
  async hover(): Promise<void> {}
  async pressKey(): Promise<void> {}
  async selectOption(): Promise<void> {}
  async reload(): Promise<void> {}
  async goBack(): Promise<void> {}
  async uploadFile(): Promise<void> {}
  async dragAndDrop(): Promise<void> {}
  async blur(): Promise<void> {}
  async mouse(): Promise<void> {}
  async openTab(): Promise<string> {
    return 'tab-0';
  }
  async switchTab(): Promise<void> {}
  async closeTab(): Promise<void> {}
  async screenshot(): Promise<Buffer> {
    return Buffer.from('fake-png');
  }
  async setLogpoint(): Promise<void> {}
  drainConsole(): ConsoleEntry[] {
    return [];
  }
  drainNetwork(): NetworkEntry[] {
    return [];
  }
  async close(): Promise<void> {}
}

{
  const clobber = new ClobberBrowser();
  const a3Router = fakeRouter([
    {
      thought: 'click both buttons',
      actions: [
        { type: 'click', nodeId: 'n1' },
        { type: 'click', nodeId: 'n2' },
      ],
    },
    { thought: 'done', actions: [{ type: 'finish', verdict: 'pass', reason: 'both clicked (allegedly)' }] },
  ]);
  const a3Report = await runDriverLoop(
    clobber,
    a3Router,
    new ArtifactStore(path.join(root, 'a3')),
    'click foo then bar',
    'http://localhost/clobber',
    { maxSteps: 6 },
  );
  check(
    'A3: only the first batch action (and its retry) were ever attempted — the second was discarded, not misdirected',
    clobber.attemptedClicks.length === 2 && clobber.attemptedClicks[0] === 'n1' && clobber.attemptedClicks[1] === 'm1',
  );
  check('A3: the discarded batch action never resolved against the rebuilt node map (n2/m2 never clicked)', !clobber.attemptedClicks.includes('n2') && !clobber.attemptedClicks.includes('m2'));
  check('A3: the click batch produced exactly one step record (the second action was skipped, not recorded as a wrong-element success)', a3Report.steps[0]?.action.type === 'click');
  check('A3: the run still finished normally afterward (the dropped batch action was re-planned next step, not fatal)', a3Report.verdict === 'pass');
}

// ---------------------------------------------------------------------------
// A6 — a mid-run throw still yields a persisted, evidence-bearing report
// ---------------------------------------------------------------------------

{
  const crashBrowser = new SimpleBrowser();
  crashBrowser.axTreeShouldThrowOnCall = 2; // 1st axTree() call (the batch snapshot) succeeds; the 2nd throws
  const store = new ArtifactStore(path.join(root, 'a6'));
  const a6Report = await runDriverLoop(
    crashBrowser,
    fakeRouter([{ thought: 'click submit', actions: [{ type: 'click', nodeId: 'n1' }] }]),
    store,
    'submit the form',
    'http://localhost/simple',
    { maxSteps: 6 },
  );
  check('A6: a mid-run axTree() throw does not reject runDriverLoop — it returns a report', a6Report !== undefined);
  check('A6: the crash report is uncertain, not a silently-swallowed pass/fail', a6Report.verdict === 'uncertain');
  check('A6: the crash reason carries the underlying error', a6Report.reason.includes('simulated CDP disconnect'));
  check('A6: whatever accumulated before the crash (the one successful click) is still in the report', a6Report.steps.length === 1 && a6Report.steps[0]?.ok === true);

  const reportOnDisk = JSON.parse(fs.readFileSync(path.join(store.dir, 'report.json'), 'utf8'));
  check('A6: the report was actually persisted to disk via the normal saveReport path', reportOnDisk.verdict === 'uncertain' && reportOnDisk.runId === store.runId);
}

// ---------------------------------------------------------------------------

const failed = checks.filter(([, ok]) => !ok);
console.log(`\nV53 driver-hardening checks: ${checks.length - failed.length}/${checks.length} passed.`);
if (failed.length) {
  console.error(`FAILED: ${failed.map(([label]) => label).join(', ')}`);
  process.exit(1);
}
