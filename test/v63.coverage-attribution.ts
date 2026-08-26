/* v63 — A51 (P2): coverage attribution mis-matched a same-role+name element to
 * the WRONG structural state of a route.
 *
 * Before this fix, `applyRunToModel` (src/discovery/record-coverage.ts) walked
 * a route's `states` array and stopped at the FIRST state containing a
 * matching role+name element — so a "Delete" button present in both an older
 * and a newer recorded state of the same route always got attributed to
 * whichever state happened to be inserted first, regardless of which state
 * the run was actually exercising. The fix collects ALL matching (state,
 * element) candidates across the route's whole history and disambiguates
 * with `step.target.nth` (mirroring recorder/replay.ts's document-order `nth`
 * scoring) when present, else prefers the most-recently-seen state.
 *
 *  Run: npx tsx test/v63.coverage-attribution.ts   (exits nonzero on any failed check)
 */

import { applyRunToModel } from '../src/discovery/record-coverage.js';
import { emptyAppModel, upsertCrawledPage } from '../src/discovery/app-model.js';
import type { StepRecord } from '../src/report/report.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
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

console.log('=== v63: A51 cross-state coverage attribution ===');

/* ---------- 1) same role+name in two states → attributed to the MOST RECENT one, not the first ---------- */
{
  const m = emptyAppModel('http://localhost:9401/');
  // Older structural state, discovered first.
  upsertCrawledPage(
    m,
    {
      url: 'http://localhost:9401/dashboard',
      normalizedUrl: 'http://localhost:9401/dashboard',
      routePattern: '/dashboard',
      depth: 0,
      status: 200,
      structuralSignature: 'sig-old',
      contentSignature: 'content-old',
      interactiveElements: [{ role: 'button', name: 'Delete' }],
      links: [],
    },
    '2026-01-01T00:00:00.000Z',
  );
  // Newer structural state (e.g. a redesign), discovered later — same route,
  // ALSO has a "Delete" button. The ledger keeps both (see app-model.ts's
  // file header on state history), which is exactly the ambiguity A51 covers.
  upsertCrawledPage(
    m,
    {
      url: 'http://localhost:9401/dashboard',
      normalizedUrl: 'http://localhost:9401/dashboard',
      routePattern: '/dashboard',
      depth: 0,
      status: 200,
      structuralSignature: 'sig-new',
      contentSignature: 'content-new',
      interactiveElements: [{ role: 'button', name: 'Delete' }],
      links: [],
    },
    '2026-06-01T00:00:00.000Z',
  );

  const result = applyRunToModel(
    m,
    [step({ url: 'http://localhost:9401/dashboard', target: { role: 'button', name: 'Delete' } })],
    'run-1',
  );
  check('element touch recorded (not skipped)', result.elementsMarked === 1);

  const route = m.routes.find((r) => r.route === 'http://localhost:9401/dashboard')!;
  const oldState = route.states.find((s) => s.structuralSignature === 'sig-old')!;
  const newState = route.states.find((s) => s.structuralSignature === 'sig-new')!;
  check(
    'attributed to the MOST RECENTLY SEEN state (sig-new), not the first-inserted one (sig-old)',
    newState.elements[0].touchedAt !== undefined && oldState.elements[0].touchedAt === undefined,
  );
}

/* ---------- 2) with an explicit nth hint, document-order index wins over recency ---------- */
{
  const m = emptyAppModel('http://localhost:9401/');
  const sigs = ['sig-0', 'sig-1', 'sig-2'];
  const times = ['2026-01-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'];
  for (let i = 0; i < sigs.length; i++) {
    upsertCrawledPage(
      m,
      {
        url: 'http://localhost:9401/rows',
        normalizedUrl: 'http://localhost:9401/rows',
        routePattern: '/rows',
        depth: 0,
        status: 200,
        structuralSignature: sigs[i],
        contentSignature: `content-${i}`,
        interactiveElements: [{ role: 'button', name: 'Expand row' }],
        links: [],
      },
      times[i],
    );
  }
  // nth=1 (0-based, document/discovery order across states) should pick the
  // MIDDLE state's element (sig-1) — NOT the most recent (sig-2), proving nth
  // takes priority over the recency fallback when it clearly disambiguates.
  const result = applyRunToModel(
    m,
    [step({ url: 'http://localhost:9401/rows', target: { role: 'button', name: 'Expand row', nth: 1 } })],
    'run-2',
  );
  check('element touch recorded', result.elementsMarked === 1);
  const route = m.routes.find((r) => r.route === 'http://localhost:9401/rows')!;
  const touchedSig = route.states.find((s) => s.elements[0].touchedAt !== undefined)?.structuralSignature;
  check('nth=1 picks the MIDDLE state (sig-1), not the most recent (sig-2)', touchedSig === 'sig-1');
}

/* ---------- 3) single-candidate case (the common case) is unaffected ---------- */
{
  const m = emptyAppModel('http://localhost:9401/');
  upsertCrawledPage(m, {
    url: 'http://localhost:9401/products',
    normalizedUrl: 'http://localhost:9401/products',
    routePattern: '/products',
    depth: 0,
    status: 200,
    structuralSignature: 'sig-a',
    contentSignature: 'content-a',
    interactiveElements: [{ role: 'button', name: 'Add to cart' }],
    links: [],
  });
  const result = applyRunToModel(
    m,
    [step({ url: 'http://localhost:9401/products', target: { role: 'button', name: 'Add to cart' } })],
    'run-3',
  );
  check('single-state route: element still marked touched exactly as before', result.elementsMarked === 1);
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v63 checks passed`);
process.exit(failed.length ? 1 : 0);
