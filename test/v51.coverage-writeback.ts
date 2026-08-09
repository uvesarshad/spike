/* v51 — A29: the coverage write-back.
 *
 * `spike map` wrote .spike/app-model.json and NOTHING ever updated it, so
 * `spike coverage` reported 0 exercised forever — an answer that looks real and
 * is wrong. These checks pin the write-back's behaviour, especially the parts
 * that are judgement calls rather than mechanics: which steps count, what
 * happens to routes the crawler never found, and that a missing ledger is a
 * no-op rather than an error.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyRunToModel, recordRunCoverage } from '../src/discovery/record-coverage.js';
import { emptyAppModel, loadAppModel, saveAppModel, upsertCrawledPage } from '../src/discovery/app-model.js';
import type { StepRecord } from '../src/report/report.js';

let passed = 0;
const checks: string[] = [];
const check = (label: string, ok: boolean) => {
  checks.push(label);
  if (ok) passed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const step = (over: Partial<StepRecord>): StepRecord => ({
  index: 0,
  action: { type: 'click', nodeId: 'n1' },
  description: 'click',
  ok: true,
  console: [],
  network: [],
  ts: 0,
  ...over,
});

function modelWithRoute() {
  const m = emptyAppModel('http://localhost:9401/');
  upsertCrawledPage(m, {
    url: 'http://localhost:9401/products',
    normalizedUrl: 'http://localhost:9401/products',
    routePattern: '/products',
    depth: 0,
    status: 200,
    structuralSignature: 'sig-a',
    contentSignature: 'content-a',
    interactiveElements: [
      { role: 'button', name: 'Add Widget to cart' },
      { role: 'button', name: 'Go to cart' },
    ],
    links: [],
  });
  return m;
}

console.log('=== v51 1/5: a successful step marks its route and element ===');
{
  const m = modelWithRoute();
  const r = applyRunToModel(
    m,
    [step({ url: 'http://localhost:9401/products', target: { role: 'button', name: 'Add Widget to cart' } })],
    'flow-a',
  );
  check('route marked exercised', r.routesMarked.length === 1);
  check('element marked touched', r.elementsMarked === 1);
  check('model reflects it', m.routes[0].exercised === true);
  check('script attributed', m.routes[0].coveredByScripts.includes('flow-a'));
}

console.log('\n=== v51 2/5: a FAILED step records nothing ===');
{
  // A step that threw did not successfully exercise anything; counting it
  // would inflate coverage exactly when a flow is broken.
  const m = modelWithRoute();
  const r = applyRunToModel(
    m,
    [step({ ok: false, url: 'http://localhost:9401/products', target: { role: 'button', name: 'Go to cart' } })],
    'flow-a',
  );
  check('no route marked from a failed step', r.routesMarked.length === 0);
  check('no element marked from a failed step', r.elementsMarked === 0);
}

console.log('\n=== v51 3/5: a route the ledger never discovered is surfaced, not invented ===');
{
  // Growing "discovered" from whatever a run happened to reach would make the
  // denominator mean two different things — and a run reaching surface the
  // crawler could not IS the signal that interaction-gated exploration is
  // needed, so it must be visible rather than silently absorbed.
  const m = modelWithRoute();
  const r = applyRunToModel(m, [step({ url: 'http://localhost:9401/secret-modal-route' })], 'flow-a');
  check('unknown route reported', r.unknownRoutes.length === 1);
  check('unknown route NOT added to the ledger', m.routes.length === 1);
  check('no route marked exercised', r.routesMarked.length === 0);
}

console.log('\n=== v51 4/5: URL normalisation joins on the right route ===');
{
  const m = modelWithRoute();
  const r = applyRunToModel(
    m,
    [step({ url: 'http://localhost:9401/products?utm_source=x', target: { role: 'button', name: 'Go to cart' } })],
    'flow-a',
  );
  check('tracking-param URL still matches its route', r.routesMarked.length === 1);
  check('element still matched', r.elementsMarked === 1);
}

console.log('\n=== v51 5/5: a missing ledger is a no-op, never an error ===');
{
  // Coverage is opt-in; a QA run must not fail because a bookkeeping file that
  // nobody asked for is absent.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v51-'));
  try {
    const r = recordRunCoverage([step({ url: 'http://localhost:9401/products' })], 'flow-a', dir);
    check('ledgerPresent is false', r.ledgerPresent === false);
    check('nothing marked', r.routesMarked.length === 0 && r.elementsMarked === 0);

    // …and with a ledger, it round-trips through disk.
    saveAppModel(modelWithRoute(), dir);
    const r2 = recordRunCoverage(
      [step({ url: 'http://localhost:9401/products', target: { role: 'button', name: 'Go to cart' } })],
      'flow-a',
      dir,
    );
    check('with a ledger, the route is marked', r2.routesMarked.length === 1);
    const reloaded = loadAppModel(dir);
    check('persisted to disk', reloaded?.routes[0].exercised === true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n=== v51 6/6: crawler-vs-AX name spelling still matches ===');
{
  // The real-world case that made coverage under-report: the HTML crawler
  // named an input from its `id` ("email") while the AX tree names it from its
  // <label> ("Email"). The match must succeed AND the write must land on the
  // ledger's own spelling, or it finds the element and marks nothing.
  const m = emptyAppModel('http://localhost:9401/');
  upsertCrawledPage(m, {
    url: 'http://localhost:9401/login',
    normalizedUrl: 'http://localhost:9401/login',
    routePattern: '/login',
    depth: 0,
    status: 200,
    structuralSignature: 'sig-login',
    contentSignature: 'c',
    interactiveElements: [{ role: 'textbox', name: 'email' }],
    links: [],
  });
  const r = applyRunToModel(
    m,
    [step({ url: 'http://localhost:9401/login', target: { role: 'textbox', name: 'Email' } })],
    'flow-login',
  );
  check('case-differing name still matches', r.elementsMarked === 1);
  const el = m.routes[0].states.flatMap((st) => st.elements)[0];
  check('the write actually landed on the ledger entry', Boolean(el.touchedAt));
}

console.log(`\nV51 coverage-writeback checks passed (${passed}/${checks.length}).`);
process.exit(passed === checks.length ? 0 : 1);
