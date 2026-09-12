/* V79 — the fan-out orchestrator (audit finding A8).
 *
 * A single run has a hard step budget, so "test my whole app" was impossible
 * and there was nothing above one run to spend a second budget on. This suite
 * pins the layer that fixes it:
 *
 *   1. one verdict from many runs — fail beats uncertain beats pass, and an
 *      empty sweep is never a pass;
 *   2. coverage accounting — flows got through, pages reached (de-duplicated
 *      across flows), controls actually operated (de-duplicated within a flow,
 *      so the repeated-check livelock cannot inflate it);
 *   3. the coverage line reaching the two things a person reads: the plain
 *      report and the flow table;
 *   4. routes (the future input from app-model discovery) normalizing into the
 *      same testable units as flows;
 *   5. the document path (A7) sharing this exact loop rather than owning a
 *      second copy of it.
 *
 * Pure/in-memory: every run is a stub. No Chrome, no network, no API keys.
 *
 * Run: npx tsx test/v79.fan-out-orchestrator.ts
 */

import assert from 'node:assert/strict';
import {
  aggregateVerdict,
  coverageFromSteps,
  flowsFromRoutes,
  renderCoverageLine,
  renderFlowTable,
  runFanOut,
  singleRunCoverage,
  type FlowUnit,
} from '../src/orchestrator/fan-out.js';
import { runFlows } from '../src/driver/spec-decompose.js';
import { renderPlainReport } from '../src/vibe/fix-prompt.js';
import type { Report, RunVerdict, StepRecord } from '../src/report/report.js';

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

const FLOWS: FlowUnit[] = [
  { name: 'Sign in', task: 'sign in' },
  { name: 'Add to cart', task: 'add to cart' },
  { name: 'Checkout', task: 'check out' },
];

function step(partial: Partial<StepRecord> & { index: number }): StepRecord {
  return {
    thought: undefined,
    action: { type: 'click', nodeId: 'n1' },
    description: '',
    ok: true,
    console: [],
    network: [],
    ts: 0,
    ...partial,
  } as StepRecord;
}

/* ---- 1) one verdict from many runs --------------------------------------- */

await check('one verdict from many: fail beats uncertain beats pass', () => {
  assert.equal(aggregateVerdict(['pass', 'pass']), 'pass');
  assert.equal(aggregateVerdict(['pass', 'uncertain']), 'uncertain');
  assert.equal(aggregateVerdict(['pass', 'uncertain', 'fail']), 'fail');
  assert.equal(aggregateVerdict(['fail', 'fail']), 'fail');
  assert.equal(aggregateVerdict(['uncertain']), 'uncertain');
  // nothing checked is never a pass
  assert.equal(aggregateVerdict([]), 'uncertain');
});

await check('the aggregate verdict is what the fan-out reports', async () => {
  const verdicts: RunVerdict[] = ['pass', 'fail', 'uncertain'];
  const outcome = await runFanOut(FLOWS, {
    runFlow: async (_f, i) => ({ verdict: verdicts[i] }),
  });
  assert.equal(outcome.verdict, 'fail');
  assert.equal(outcome.flows.length, 3);

  const allPass = await runFanOut(FLOWS, { runFlow: async () => ({ verdict: 'pass' as RunVerdict }) });
  assert.equal(allPass.verdict, 'pass');

  const oneUnsure = await runFanOut(FLOWS, {
    runFlow: async (_f, i) => ({ verdict: (i === 1 ? 'uncertain' : 'pass') as RunVerdict }),
  });
  assert.equal(oneUnsure.verdict, 'uncertain');
});

await check('a flow that throws is "not sure", and the rest still run', async () => {
  const ran: string[] = [];
  const outcome = await runFanOut(FLOWS, {
    runFlow: async (flow) => {
      ran.push(flow.name);
      if (flow.name === 'Add to cart') throw new Error('Chrome went away');
      return { verdict: 'pass' as RunVerdict };
    },
  });
  assert.equal(ran.length, 3, 'every flow was attempted');
  assert.equal(outcome.flows[1].verdict, 'uncertain');
  assert.ok(outcome.flows[1].reason.includes('Chrome went away'));
  assert.equal(outcome.verdict, 'uncertain');
});

await check('every flow gets its own run, with the shared sign-in state and budget', async () => {
  const seen: Array<{ index: number; total: number; storageStatePath?: string; maxSteps?: number }> = [];
  await runFanOut(FLOWS, {
    storageStatePath: '/tmp/auth.json',
    maxStepsPerFlow: 60,
    runFlow: async (_f, _i, ctx) => {
      seen.push(ctx);
      return { verdict: 'pass' as RunVerdict };
    },
  });
  assert.equal(seen.length, 3);
  assert.deepEqual(seen.map((c) => c.index), [0, 1, 2]);
  assert.ok(seen.every((c) => c.total === 3));
  assert.ok(seen.every((c) => c.storageStatePath === '/tmp/auth.json'), 'same sign-in state for every flow');
  assert.ok(seen.every((c) => c.maxSteps === 60), 'each flow gets its own budget');
});

/* ---- 2) coverage accounting ---------------------------------------------- */

await check('coverage counts distinct pages and distinct controls', () => {
  const steps: StepRecord[] = [
    step({ index: 0, action: { type: 'navigate', url: 'http://app.test/login' }, url: 'http://app.test/login' }),
    step({ index: 1, action: { type: 'type', nodeId: 'n1', text: 'a' }, url: 'http://app.test/login', target: { role: 'textbox', name: 'Email' } }),
    step({ index: 2, action: { type: 'click', nodeId: 'n2' }, url: 'http://app.test/login', target: { role: 'button', name: 'Sign in' } }),
    // same button, same page, clicked twice — one control, not two
    step({ index: 3, action: { type: 'click', nodeId: 'n2' }, url: 'http://app.test/login', target: { role: 'button', name: 'Sign in' } }),
    // a page-level check operates nothing
    step({ index: 4, action: { type: 'assert_text', mode: 'contains', value: 'Welcome' }, url: 'http://app.test/account' }),
    // a failed click did not exercise anything
    step({ index: 5, action: { type: 'click', nodeId: 'n3' }, ok: false, url: 'http://app.test/account', target: { role: 'button', name: 'Delete' } }),
    // the fragment is not a different page
    step({ index: 6, action: { type: 'click', nodeId: 'n4' }, url: 'http://app.test/account#top', target: { role: 'link', name: 'Orders' } }),
  ];
  const c = coverageFromSteps(steps, 'http://app.test/');
  assert.deepEqual(c.pages.sort(), ['http://app.test/', 'http://app.test/account', 'http://app.test/login']);
  assert.equal(c.controlsExercised, 3, 'email field, sign-in button, orders link');

  const single = singleRunCoverage(steps, 'http://app.test/');
  assert.deepEqual(single, { flowsAttempted: 1, flowsTotal: 1, pagesVisited: 3, controlsExercised: 3 });
});

await check('fan-out coverage unions pages across flows and totals the controls', async () => {
  const outcome = await runFanOut(FLOWS, {
    runFlow: async (flow) => ({
      verdict: (flow.name === 'Checkout' ? 'fail' : 'pass') as RunVerdict,
      url: 'http://app.test/',
      steps: [
        // every flow starts on the same page — counted once overall
        step({ index: 0, action: { type: 'navigate', url: 'http://app.test/' }, url: 'http://app.test/' }),
        step({ index: 1, action: { type: 'click', nodeId: 'n1' }, url: `http://app.test/${flow.name}`, target: { role: 'button', name: flow.name } }),
      ],
    }),
  });
  assert.equal(outcome.coverage.flowsTotal, 3);
  assert.equal(outcome.coverage.flowsAttempted, 3);
  assert.equal(outcome.coverage.pagesVisited, 4, 'the shared start page plus one per flow');
  assert.equal(outcome.coverage.controlsExercised, 3);
  assert.equal(outcome.flows[0].coverage?.flowsTotal, 1, 'each flow carries its own coverage too');
});

await check('a sweep cut short reports how far it got, not how far it meant to go', async () => {
  const outcome = await runFanOut(FLOWS, {
    stopOnFirstFailure: true,
    runFlow: async (_f, i) => ({ verdict: (i === 1 ? 'fail' : 'pass') as RunVerdict }),
  });
  assert.equal(outcome.coverage.flowsAttempted, 2);
  assert.equal(outcome.coverage.flowsTotal, 3);
  assert.equal(outcome.verdict, 'fail');
});

/* ---- 3) the coverage line a person reads --------------------------------- */

await check('the coverage line appears in the plain report on a non-pass verdict', () => {
  const report = {
    verdict: 'uncertain' as RunVerdict,
    failing_step: null,
    console_error: null,
    evidence_paths: [],
    reason: 'I ran out of moves before finishing.',
    runId: 'r1',
    task: 'test the shop',
    url: 'http://app.test/',
    steps: [step({ index: 0, action: { type: 'click', nodeId: 'n1' }, url: 'http://app.test/' })],
    model_trace: [],
    durationMs: 1000,
    tokenEstimate: 100,
    coverage: { flowsAttempted: 2, flowsTotal: 5, pagesVisited: 4, controlsExercised: 11 },
  } as unknown as Report;

  const text = renderPlainReport(report);
  assert.ok(/I got through 2 of 5 flows/.test(text), text);
  assert.ok(/4 pages/.test(text), text);
  assert.ok(/11 controls/.test(text), text);
  // §1.5 vocabulary: nothing internal in a line a person reads
  assert.ok(!/rung|navigator|brain|planner|CDP|daemon|a11y|budget|goal/i.test(renderCoverageLine(report.coverage!)));
});

await check('a passing report says nothing about coverage', () => {
  const report = {
    verdict: 'pass' as RunVerdict,
    failing_step: null,
    console_error: null,
    evidence_paths: [],
    reason: 'done',
    runId: 'r1',
    task: 'test the shop',
    url: 'http://app.test/',
    steps: [step({ index: 0 })],
    model_trace: [],
    durationMs: 1,
    tokenEstimate: 1,
  } as unknown as Report;
  assert.ok(!/I got through/.test(renderPlainReport(report)));
});

await check('the flow table carries the coverage line when it did not all pass', async () => {
  const outcome = await runFanOut(FLOWS, {
    runFlow: async (_f, i) => ({ verdict: (i === 2 ? 'fail' : 'pass') as RunVerdict, reason: i === 2 ? 'Place order threw.' : '' }),
  });
  const table = renderFlowTable(outcome);
  assert.ok(/I got through 3 of 3 flows/.test(table), table);
  assert.ok(/Overall: fail/.test(table), table);

  const clean = await runFanOut(FLOWS, { runFlow: async () => ({ verdict: 'pass' as RunVerdict }) });
  assert.ok(!/I got through/.test(renderFlowTable(clean)), 'a clean sweep needs no qualifier');
});

await check('the coverage line pluralizes like English', () => {
  assert.equal(
    renderCoverageLine({ flowsAttempted: 1, flowsTotal: 1, pagesVisited: 1, controlsExercised: 1 }),
    'I got through 1 of 1 flow, visited 1 page and tried 1 control.',
  );
  assert.equal(
    renderCoverageLine({ flowsAttempted: 0, flowsTotal: 3, pagesVisited: 0, controlsExercised: 0 }),
    'I got through 0 of 3 flows, visited 0 pages and tried 0 controls.',
  );
});

/* ---- 4) routes as an input shape ----------------------------------------- */

await check('discovered routes become testable units against the same loop', async () => {
  const units = flowsFromRoutes(
    [
      { path: '/', name: 'Home' },
      { path: '/pricing', title: 'Pricing' },
      { url: 'http://app.test/contact' },
      { path: '/checkout', name: 'Checkout', task: 'Buy one widget and check the confirmation shows an order number.' },
    ],
    { baseUrl: 'http://app.test/' },
  );
  assert.equal(units.length, 4);
  assert.deepEqual(units.map((u) => u.name), ['Home', 'Pricing', 'http://app.test/contact', 'Checkout']);
  assert.ok(units[1].task.includes('http://app.test/pricing'), units[1].task);
  assert.equal(units[3].task, 'Buy one widget and check the confirmation shows an order number.');

  const outcome = await runFanOut(units, { runFlow: async () => ({ verdict: 'pass' as RunVerdict }) });
  assert.equal(outcome.coverage.flowsTotal, 4);
});

await check('routes obey the same caps as flows', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ path: `/p${i}` }));
  assert.equal(flowsFromRoutes(many, { baseUrl: 'http://app.test/' }).length, 20);
  assert.equal(flowsFromRoutes(many, { baseUrl: 'http://app.test/', maxFlows: 5 }).length, 5);
});

/* ---- 5) one loop, not two ------------------------------------------------ */

await check('the document path runs on this very orchestrator', async () => {
  assert.equal(runFlows, runFanOut, 'spec-decompose re-exports the shared loop rather than owning a copy');
  const outcome = await runFlows(FLOWS, { runFlow: async () => ({ verdict: 'pass' as RunVerdict }) });
  assert.equal(outcome.coverage.flowsTotal, 3);
});

if (failures) {
  console.error(`\nV79: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nV79: all checks passed');
