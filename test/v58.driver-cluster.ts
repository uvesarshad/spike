/**
 * V58 — driver-loop cluster (26-08-27 market-readiness audit, A19/A20/A21/A26/A27/A28).
 * Pure unit coverage, no Chrome/model calls — stub BrowserPort + ModelRouter,
 * same style as test/v53.driver-hardening.ts and test/v31.action-cache-driver.ts.
 *
 * Covers:
 *  - A19: click/type/hover/select/drag get a Playwright-style actionability
 *    wait (browser.waitForActionable) BEFORE dispatch, both on the live
 *    navigator path and the action-cache path.
 *  - A20: a mutating cached action is verified (actionability) against the
 *    CURRENT tree BEFORE it is dispatched — a failed check is a cache MISS,
 *    never an execute-then-check.
 *  - A21: an ambiguous role+name cache-target match with no `nth` resolves to
 *    a miss (null), never `matches[0]`.
 *  - A26: `goalComplete` transitions are bounded by a fixed whole-run budget
 *    even when a misbehaving brain keeps re-extending the goal list.
 *  - A27: the 3×-repeat detector resets at goal transitions and does not fire
 *    when the repeated action actually changed the page (e.g. a stepper "+").
 *  - A28: `drag_and_drop` gets the same stale-node retry every other
 *    nodeId-based verb gets.
 *
 * Run: npx tsx test/v58.driver-cluster.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDriverLoop } from '../src/driver/loop.js';
import { ArtifactStore } from '../src/report/artifacts.js';
import { FileActionCache, actionFromCachedValue } from '../src/cache/action-cache.js';
import type { AxNode, AxSnapshot, BrowserPort, ConsoleEntry, NetworkEntry, WaitForActionableOptions } from '../src/ports/browser-port.js';
import type { ModelRouter } from '../src/router/model-router.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-v58-'));

/** Navigator-only stub router (no plan-goals adapter) — serves queued
 * planJson responses in order. */
function fakeNavigatorRouter(planQueue: unknown[]) {
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

/** Brain-available stub router — serves queued planJson (navigator) AND
 * planGoals (brain) responses independently, in order. */
function fakeBrainRouter(planQueue: unknown[], goalsQueue: unknown[]) {
  let planCalls = 0;
  let goalCalls = 0;
  return {
    trace: [],
    get planCalls() {
      return planCalls;
    },
    get goalCalls() {
      return goalCalls;
    },
    async hasCapability(): Promise<boolean> {
      return true;
    },
    async planJson(): Promise<unknown> {
      planCalls++;
      const next = planQueue.shift();
      assert.ok(next, 'expected queued navigator plan');
      return next;
    },
    async planGoals(): Promise<unknown> {
      goalCalls++;
      const next = goalsQueue.shift();
      assert.ok(next, 'expected queued brain goal-plan');
      return next;
    },
    async visualVerdict(): Promise<unknown> {
      return { verdict: 'pass', summary: 'ok', issues: [] };
    },
  } as unknown as ModelRouter & { planCalls: number; goalCalls: number };
}

// ---------------------------------------------------------------------------
// A19 — actionability wait fires BEFORE mutation verbs on the LIVE path
// ---------------------------------------------------------------------------

class WaitTrackingBrowser implements BrowserPort {
  private currentUrl = 'http://localhost/a19';
  calls: string[] = [];

  async launch(): Promise<void> {}
  async navigate(u: string): Promise<void> {
    this.currentUrl = u;
  }
  async url(): Promise<string> {
    return this.currentUrl;
  }
  async axTree(): Promise<AxSnapshot> {
    const root: AxNode = {
      id: 'root',
      role: 'document',
      name: 'App',
      children: [
        { id: 'n1', role: 'button', name: 'Submit' },
        { id: 'n2', role: 'textbox', name: 'Name' },
      ],
    };
    return { root, text: 'document "App"\n  button "Submit"\n  textbox "Name"', truncated: false };
  }
  async waitForActionable(nodeId: string, _opts?: WaitForActionableOptions): Promise<void> {
    this.calls.push(`wait:${nodeId}`);
  }
  async click(nodeId: string): Promise<void> {
    this.calls.push(`click:${nodeId}`);
  }
  async type(nodeId: string, _text: string): Promise<void> {
    this.calls.push(`type:${nodeId}`);
  }
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
  const browser = new WaitTrackingBrowser();
  const a19Router = fakeNavigatorRouter([
    { thought: 'fill and submit', actions: [{ type: 'type', nodeId: 'n2', text: 'Ada' }, { type: 'click', nodeId: 'n1' }] },
    { thought: 'done', actions: [{ type: 'finish', verdict: 'pass', reason: 'submitted' }] },
  ]);
  const a19Report = await runDriverLoop(
    browser,
    a19Router,
    new ArtifactStore(path.join(root, 'a19')),
    'fill the form and submit',
    'http://localhost/a19',
    { maxSteps: 6 },
  );
  check('A19: the run completed normally', a19Report.verdict === 'pass');
  check(
    'A19: waitForActionable(n2) was invoked BEFORE type(n2)',
    browser.calls.indexOf('wait:n2') !== -1 && browser.calls.indexOf('wait:n2') < browser.calls.indexOf('type:n2'),
  );
  check(
    'A19: waitForActionable(n1) was invoked BEFORE click(n1)',
    browser.calls.indexOf('wait:n1') !== -1 && browser.calls.indexOf('wait:n1') < browser.calls.indexOf('click:n1'),
  );
}

// ---------------------------------------------------------------------------
// A19 (timeout path) + A28 — drag_and_drop gets the wait AND the stale-node retry
// ---------------------------------------------------------------------------

class DragBrowser implements BrowserPort {
  private currentUrl = 'http://localhost/a28';
  private snapshotCalls = 0;
  waitCalls: string[] = [];
  dragCalls: [string, string][] = [];

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
      const root: AxNode = {
        id: 'root',
        role: 'document',
        name: 'App',
        children: [
          { id: 'n1', role: 'listitem', name: 'Card A' },
          { id: 'n2', role: 'region', name: 'Done column' },
        ],
      };
      return { root, text: 'document "App"\n  listitem "Card A"\n  region "Done column"', truncated: false };
    }
    // any later snapshot (the retry's re-resolve) returns REBUILT ids —
    // same role+name, different id, simulating a rebuilt nodeId map.
    const root: AxNode = {
      id: 'root',
      role: 'document',
      name: 'App',
      children: [
        { id: 'm1', role: 'listitem', name: 'Card A' },
        { id: 'm2', role: 'region', name: 'Done column' },
      ],
    };
    return { root, text: 'document "App"\n  listitem "Card A"\n  region "Done column"', truncated: false };
  }
  async waitForActionable(nodeId: string): Promise<void> {
    this.waitCalls.push(nodeId);
    // A19: a timeout on the FIRST (stale-id) attempt must not block the
    // action — dragAndDrop still gets attempted below.
    if (nodeId === 'n1' || nodeId === 'n2') {
      throw new Error('not actionable in time');
    }
  }
  async click(): Promise<void> {}
  async type(): Promise<void> {}
  async hover(): Promise<void> {}
  async pressKey(): Promise<void> {}
  async selectOption(): Promise<void> {}
  async reload(): Promise<void> {}
  async goBack(): Promise<void> {}
  async uploadFile(): Promise<void> {}
  async dragAndDrop(sourceId: string, targetId: string): Promise<void> {
    this.dragCalls.push([sourceId, targetId]);
    // the batch snapshot's stale ids (n1/n2) always fail — drives the
    // stale-node retry; the retry's resolved ids (m1/m2) succeed.
    if (sourceId === 'n1' || targetId === 'n2') throw new Error('simulated stale node — detached before drag');
  }
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
  const drag = new DragBrowser();
  const a28Router = fakeNavigatorRouter([
    { thought: 'move the card', actions: [{ type: 'drag_and_drop', sourceId: 'n1', targetId: 'n2' }] },
    { thought: 'done', actions: [{ type: 'finish', verdict: 'pass', reason: 'card moved' }] },
  ]);
  const a28Report = await runDriverLoop(
    drag,
    a28Router,
    new ArtifactStore(path.join(root, 'a28')),
    'drag card A to the done column',
    'http://localhost/a28',
    { maxSteps: 6 },
  );
  check('A19/A28: waitForActionable was probed for BOTH the source and target', drag.waitCalls.includes('n1') && drag.waitCalls.includes('n2'));
  check(
    'A28: a stale source/target on the FIRST attempt is retried once against a fresh role+name resolution',
    drag.dragCalls.length === 2 && drag.dragCalls[0][0] === 'n1' && drag.dragCalls[1][0] === 'm1' && drag.dragCalls[1][1] === 'm2',
  );
  check('A19: the timed-out wait did not block dispatch — the drag still ran (proceeded anyway)', a28Report.verdict === 'pass');
  check(
    'A19: the step record notes the wait did not confirm actionability first',
    a28Report.steps[0]?.description.includes('without confirming actionability'),
  );
}

// ---------------------------------------------------------------------------
// A21 — ambiguous cache-target collisions resolve to a miss, not matches[0]
// ---------------------------------------------------------------------------

{
  const ax: AxSnapshot = {
    root: {
      id: 'root',
      role: 'document',
      name: 'List',
      children: [
        { id: 'n1', role: 'button', name: 'Delete' },
        { id: 'n2', role: 'button', name: 'Delete' },
      ],
    },
    text: 'document "List"\n  button "Delete"\n  button "Delete"',
    truncated: false,
  };
  const ambiguous = await actionFromCachedValue({ type: 'click', target: { role: 'button', name: 'Delete' } }, ax);
  check('A21: an ambiguous role+name match with no nth resolves to a cache MISS (null), not matches[0]', ambiguous === null);

  const disambiguated = await actionFromCachedValue({ type: 'click', target: { role: 'button', name: 'Delete', nth: 1 } }, ax);
  check(
    'A21: an explicit nth still disambiguates correctly (unchanged behavior)',
    disambiguated?.type === 'click' && disambiguated.nodeId === 'n2',
  );

  const unique = await actionFromCachedValue({ type: 'click', target: { role: 'button', name: 'Solo' } }, {
    root: { id: 'root', role: 'document', name: 'List', children: [{ id: 'n3', role: 'button', name: 'Solo' }] },
    text: '',
    truncated: false,
  });
  check('A21: a single unambiguous match still resolves normally', unique?.type === 'click' && unique.nodeId === 'n3');
}

// ---------------------------------------------------------------------------
// A20 — action cache verifies actionability BEFORE dispatching a mutation;
// a failed check is a cache miss, never an execute-then-check
// ---------------------------------------------------------------------------

class CacheableBrowser implements BrowserPort {
  private currentUrl = 'http://localhost/a20';
  clicked = false;

  async launch(): Promise<void> {}
  async navigate(url: string): Promise<void> {
    this.currentUrl = url;
    this.clicked = false;
  }
  async url(): Promise<string> {
    return this.currentUrl;
  }
  async axTree(): Promise<AxSnapshot> {
    const root: AxNode = {
      id: 'root',
      role: 'document',
      name: 'Fake app',
      children: [
        { id: 'n1', role: 'button', name: 'Continue' },
        { id: 'n2', role: 'status', name: this.clicked ? 'Clicked' : 'Not clicked' },
      ],
    };
    return {
      root,
      text: `document "Fake app"\n  button "Continue"\n  status "${this.clicked ? 'Clicked' : 'Not clicked'}"`,
      truncated: false,
    };
  }
  async click(nodeId: string): Promise<void> {
    assert.equal(nodeId, 'n1');
    this.clicked = true;
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

/** Same page/behaviour as CacheableBrowser, but waitForActionable ALWAYS
 * throws (never actionable) — simulates a cached target that is still
 * present and unambiguous, but not currently dispatchable (behind a modal,
 * disabled pending another action). */
class NeverActionableBrowser extends CacheableBrowser {
  async waitForActionable(): Promise<void> {
    throw new Error('not actionable in time');
  }
}

{
  const cache = new FileActionCache(path.join(root, 'a20-cache'));

  // Run 1: populate the cache normally (no waitForActionable on this browser
  // — optional method absent, so the A20 pre-check no-ops and the click
  // proceeds; the existing post-execute effect check stores the entry).
  const firstRouter = fakeNavigatorRouter([
    { thought: 'click continue', actions: [{ type: 'click', nodeId: 'n1' }] },
    { thought: 'done', actions: [{ type: 'finish', verdict: 'pass', reason: 'clicked' }] },
  ]);
  const firstReport = await runDriverLoop(
    new CacheableBrowser(),
    firstRouter,
    new ArtifactStore(path.join(root, 'a20-first')),
    'click continue',
    'http://localhost/a20',
    { maxSteps: 6, actionCache: cache },
  );
  check('A20 setup: the cache was populated by a normal run', firstReport.action_cache?.stored === 1);

  // Run 2: the SAME context now resolves to a cache hit, but the target is
  // never actionable — A20 requires this to be treated as a cache MISS,
  // falling through to the navigator, rather than dispatching the click and
  // discovering the problem afterward.
  const secondRouter = fakeNavigatorRouter([
    { thought: 'click continue again', actions: [{ type: 'click', nodeId: 'n1' }] },
    { thought: 'done', actions: [{ type: 'finish', verdict: 'pass', reason: 'clicked via navigator' }] },
  ]);
  const secondReport = await runDriverLoop(
    new NeverActionableBrowser(),
    secondRouter,
    new ArtifactStore(path.join(root, 'a20-second')),
    'click continue',
    'http://localhost/a20',
    { maxSteps: 6, actionCache: cache },
  );
  check('A20: a cached mutation that fails the actionability check is never dispatched from the cache path — it is a MISS', secondReport.action_cache?.hits === 0);
  check('A20: the failed actionability check is counted as stale (a miss), not silently ignored', (secondReport.action_cache?.stale ?? 0) >= 1);
  check(
    'A20: the step that DID land came from the navigator, not the cache (thought is not "cached action")',
    secondReport.steps[0]?.thought !== 'cached action',
  );
  check('A20: the run still completed correctly via the navigator fallback', secondReport.verdict === 'pass');
  check('A20: BOTH navigator turns were consumed — the cache never short-circuited the plan', secondRouter.planCalls === 2);
}

// ---------------------------------------------------------------------------
// A26 — goalComplete transitions are bounded by a FIXED whole-run budget,
// even when a misbehaving brain keeps re-extending the goal list on every
// escalation (each goalComplete resets the escalation counter, so
// MAX_BRAIN_ESCALATIONS alone cannot bound this pattern — see loop.ts's
// maxGoalTransitions doc comment).
// ---------------------------------------------------------------------------

class StaticBrowser implements BrowserPort {
  private currentUrl = 'http://localhost/a26';
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
  // 40 cycles of [navigator: blocked, navigator: goalComplete] + 40 brain
  // replans (2 new goals each, so the checklist always stays just ahead of
  // currentGoal and never naturally runs out) — WAY beyond the fixed budget
  // (initial goals.length=1 + MAX_BRAIN_ESCALATIONS(2)*12 = 25). Without the
  // A26 guard this queue would be fully consumed (80 navigator calls); with
  // it, the run must end well before that.
  const CYCLES = 40;
  const planQueue: unknown[] = [];
  const goalsQueue: unknown[] = [{ thought: 'initial plan', goals: ['reach the end'] }];
  for (let i = 0; i < CYCLES; i++) {
    planQueue.push({ thought: 'stuck', blocked: 'a modal appeared' });
    planQueue.push({ thought: 'onward', goalComplete: true });
    goalsQueue.push({ thought: 're-plan', goals: [`step ${i}a`, `step ${i}b`] });
  }
  const a26Router = fakeBrainRouter(planQueue, goalsQueue);
  const a26Report = await runDriverLoop(
    new StaticBrowser(),
    a26Router,
    new ArtifactStore(path.join(root, 'a26')),
    'reach the end',
    'http://localhost/a26',
    { maxSteps: 500 }, // deliberately generous — goalComplete does not consume stepIndex, so ONLY the A26 guard can stop this
  );
  check('A26: the run ended before the adversarial queue was exhausted', a26Router.planCalls < CYCLES * 2);
  check('A26: the run ended honestly as uncertain, not a false pass/fail', a26Report.verdict === 'uncertain');
  check('A26: the reason cites the goal-transition bound', a26Report.reason.includes('goal transitions'));
  check(
    'A26: many more brain re-plans landed than MAX_BRAIN_ESCALATIONS alone would allow — proving the OLD cap did not stop this pattern and the NEW guard did',
    a26Router.goalCalls > 3,
  );
}

// ---------------------------------------------------------------------------
// A27 — the repeat detector does not fire on a same-action streak that
// actually changes the page (a stepper "+" button), and resets at goal
// transitions.
// ---------------------------------------------------------------------------

class StepperBrowser implements BrowserPort {
  private currentUrl = 'http://localhost/a27';
  count = 0;
  async launch(): Promise<void> {}
  async navigate(u: string): Promise<void> {
    this.currentUrl = u;
  }
  async url(): Promise<string> {
    return this.currentUrl;
  }
  async axTree(): Promise<AxSnapshot> {
    const root: AxNode = {
      id: 'root',
      role: 'document',
      name: 'Stepper',
      children: [
        { id: 'n1', role: 'button', name: '+' },
        { id: 'n2', role: 'status', name: `Count: ${this.count}` },
      ],
    };
    return { root, text: `document "Stepper"\n  button "+"\n  status "Count: ${this.count}"`, truncated: false };
  }
  async click(nodeId: string): Promise<void> {
    if (nodeId === 'n1') this.count++;
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
  // Click "+" FOUR times in a row (same action signature repeated well past
  // the pre-A27 3x trip point) — each click visibly changes the status text,
  // so this must NOT escalate. Pre-A27 this would have escalated to the
  // brain after the 3rd identical click and (navigator-only, no brain
  // configured) ended the run 'uncertain' instead of finishing.
  const click = { type: 'click', nodeId: 'n1' };
  const a27Router = fakeNavigatorRouter([
    { thought: 'increment', actions: [click] },
    { thought: 'increment', actions: [click] },
    { thought: 'increment', actions: [click] },
    { thought: 'increment', actions: [click] },
    { thought: 'done', actions: [{ type: 'finish', verdict: 'pass', reason: 'counted to 4' }] },
  ]);
  const a27Report = await runDriverLoop(
    new StepperBrowser(),
    a27Router,
    new ArtifactStore(path.join(root, 'a27')),
    'click + four times',
    'http://localhost/a27',
    { maxSteps: 10 },
  );
  check(
    'A27: 4 identical clicks that each changed the page did NOT trip the repeat detector',
    a27Report.verdict === 'pass' && !a27Report.reason.includes('repeated the same action'),
  );
  check('A27: all 5 queued navigator turns were consumed (no early escalation/abort)', a27Router.planCalls === 5);
  check('A27: all 4 clicks were recorded as successful steps', a27Report.steps.filter((s) => s.action.type === 'click').length === 4);
}

// ---------------------------------------------------------------------------

const failed = checks.filter(([, ok]) => !ok);
console.log(`\nV58 driver-cluster checks: ${checks.length - failed.length}/${checks.length} passed.`);
if (failed.length) {
  console.error(`FAILED: ${failed.map(([label]) => label).join(', ')}`);
  process.exit(1);
}
