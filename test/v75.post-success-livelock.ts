/**
 * V75 — post-success livelock (audit finding A6).
 *
 * A page check that passes WITHOUT changing anything used to be replayed from
 * the shortcut store on every iteration: the page never changed, so the stored
 * step kept matching, so it kept re-running until the step budget ran out and a
 * perfectly working site was reported as "couldn't finish".
 *
 * This suite pins the three halves of the fix:
 *   1. a stored step is never replayed when the page AND the step are identical
 *      to the one that just ran — the run falls through to a fresh plan;
 *   2. a finish that settles the verdict is the last step in the history;
 *   3. the plain-English report folds back-to-back identical steps into one
 *      "(xN)" line instead of printing dozens of identical lines.
 *
 * Pure/in-memory: fake browser, fake model, stub shortcut store. No Chrome, no
 * network, no API keys.
 *
 * Run: npx tsx test/v75.post-success-livelock.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ActionCacheRecord, FileActionCache } from '../src/cache/action-cache.js';
import { runDriverLoop } from '../src/driver/loop.js';
import { ArtifactStore } from '../src/report/artifacts.js';
import type { Report, StepRecord } from '../src/report/report.js';
import { renderPlainReport } from '../src/vibe/fix-prompt.js';
import type { AxNode, AxSnapshot, BrowserPort, ConsoleEntry, NetworkEntry } from '../src/ports/browser-port.js';
import type { ModelRouter } from '../src/router/model-router.js';

let failures = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => console.log(`PASS ${name}`),
      (e) => {
        failures++;
        console.error(`FAIL ${name}: ${e instanceof Error ? e.message : e}`);
      },
    );
}

/* ---- a page that never changes, no matter what is done to it -------------- */

class StaticBrowser implements BrowserPort {
  private currentUrl = 'http://localhost/livelock';

  async launch(): Promise<void> {}
  async navigate(url: string): Promise<void> {
    this.currentUrl = url;
  }
  async url(): Promise<string> {
    return this.currentUrl;
  }
  async axTree(): Promise<AxSnapshot> {
    const root: AxNode = {
      id: 'root',
      role: 'document',
      name: 'Shop',
      children: [
        { id: 'n1', role: 'button', name: 'Place order' },
        { id: 'n2', role: 'status', name: 'Order complete' },
      ],
    };
    return {
      root,
      text: 'document "Shop"\n  button "Place order"\n  status "Order complete"',
      truncated: false,
    };
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

/* ---- a shortcut store that always offers the same passing page check ------ */

function stubCache() {
  const record: ActionCacheRecord = {
    version: 1,
    key: {
      version: 1,
      id: 'stub',
      normalizedUrl: 'http://localhost/livelock',
      normalizedGoal: 'confirm the order went through',
      actionIntent: 'assert_dom',
      pageSignature: 'stub-signature',
    },
    value: { type: 'assert_dom', target: { role: 'status', name: 'Order complete' }, contains: 'Order complete' },
    createdAt: new Date().toISOString(),
    hitCount: 3,
  };
  const state = { lookups: 0, deleted: 0 };
  const cache = {
    findForContext(): ActionCacheRecord[] {
      state.lookups++;
      return [record];
    },
    markHit(): void {},
    delete(): void {
      state.deleted++;
    },
    put(): void {},
  };
  return { cache: cache as unknown as FileActionCache, state };
}

/* ---- a model that only ever wants to finish ------------------------------- */

function finishOnlyRouter() {
  let planCalls = 0;
  const router = {
    trace: [],
    get planCalls() {
      return planCalls;
    },
    async hasCapability(): Promise<boolean> {
      return false; // single-model setup: one implicit goal, no separate planner
    },
    async planJson(): Promise<unknown> {
      planCalls++;
      return { thought: 'the order is confirmed', actions: [{ type: 'finish', verdict: 'pass', reason: 'order confirmed' }] };
    },
    async visualVerdict(): Promise<unknown> {
      return { verdict: 'pass', summary: 'order confirmation is on screen', issues: [] };
    },
  };
  return router as unknown as ModelRouter & { planCalls: number };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-v74-'));
const MAX_STEPS = 12;

const { cache, state } = stubCache();
const router = finishOnlyRouter();
const report = await runDriverLoop(
  new StaticBrowser(),
  router,
  new ArtifactStore(path.join(root, 'artifacts')),
  'confirm the order went through',
  'http://localhost/livelock',
  { maxSteps: MAX_STEPS, actionCache: cache },
);

await check('a repeated no-op shortcut does not burn the step budget', () => {
  assert.ok(state.lookups >= 2, `expected the store to be consulted more than once, got ${state.lookups}`);
  assert.equal(report.action_cache?.hits, 1, 'the same page check must be replayed exactly once');
  assert.ok(
    report.steps.length < MAX_STEPS,
    `run should end well before the ${MAX_STEPS}-step ceiling, took ${report.steps.length}`,
  );
  assert.equal(report.steps.length, 2, `expected one replay plus one finish, got ${report.steps.length}`);
});

await check('the run ends with a verdict instead of "couldn\'t finish"', () => {
  assert.equal(report.verdict, 'pass', `expected pass, got ${report.verdict}: ${report.reason}`);
});

await check('a settled finish is the last step in the history', () => {
  const last = report.steps[report.steps.length - 1];
  assert.equal(last.action.type, 'finish');
  const finishes = report.steps.filter((s) => s.action.type === 'finish');
  assert.equal(finishes.length, 1, 'exactly one finish');
});

/* ---- (c) the plain report folds identical consecutive steps --------------- */

function domStep(index: number, contains: string): StepRecord {
  return {
    index,
    action: { type: 'assert_dom', nodeId: 'n2', contains },
    description: `dom check: ${contains}`,
    target: { role: 'status', name: 'Order complete' },
    ok: true,
    console: [],
    network: [],
    ts: 1,
  } as StepRecord;
}

await check('consecutive identical steps collapse into one "(xN)" line', () => {
  const repeated: Report = {
    verdict: 'uncertain',
    task: 'confirm the order went through',
    reason: 'ran out of steps',
    steps: [
      domStep(0, 'Order complete'),
      domStep(1, 'Order complete'),
      domStep(2, 'Order complete'),
      domStep(3, 'Order complete'),
      domStep(4, 'Order complete'),
    ],
  } as unknown as Report;
  const text = renderPlainReport(repeated);
  const body = text.split('**What I did:**')[1] ?? '';
  const numbered = body.split('\n').filter((l) => /^\d+\. /.test(l));
  assert.equal(numbered.length, 1, `expected one folded line, got ${numbered.length}: ${numbered.join(' | ')}`);
  assert.ok(numbered[0].includes('(×5)'), `expected a (×5) marker, got: ${numbered[0]}`);
});

await check('non-adjacent repeats stay separate and keep their order', () => {
  const mixed: Report = {
    verdict: 'pass',
    task: 'confirm the order went through',
    reason: 'done',
    steps: [
      domStep(0, 'Order complete'),
      domStep(1, 'Order complete'),
      { ...domStep(2, 'Order complete'), action: { type: 'click', nodeId: 'n1' } } as StepRecord,
      domStep(3, 'Order complete'),
    ],
  } as unknown as Report;
  const body = renderPlainReport(mixed).split('**What I did:**')[1] ?? '';
  const numbered = body.split('\n').filter((l) => /^\d+\. /.test(l));
  assert.equal(numbered.length, 3, `expected three entries, got: ${numbered.join(' | ')}`);
  assert.ok(numbered[0].includes('(×2)'), numbered[0]);
  assert.ok(numbered[1].startsWith('2. clicked'), numbered[1]);
  assert.ok(!numbered[2].includes('(×'), numbered[2]);
});

fs.rmSync(root, { recursive: true, force: true });

if (failures) {
  console.error(`\nV75: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nV75: all checks passed');
