/* V48 — Tier 1 (differential) + Tier 2 (metamorphic) autonomous oracles
 * (A24). Pure unit coverage, no Chrome/model calls — same style as
 * test/v35.invariants.ts (the Tier-0 analogue): hand-built AxSnapshots and
 * NetworkEntry[] stand in for what the driver would capture live.
 *
 * Covers:
 *  - AX structural diff detects an added modal but ignores pure data churn
 *    (a 10 -> 11 item list of identical shape)
 *  - masks suppress a dynamic-content (timestamp) diff
 *  - network-shape diff catches a status-class change and a disappeared request
 *  - baseline save/load/bless round-trip
 *  - compareEnvironments needs no baseline
 *  - every metamorphic relation, both satisfied and violated
 *  - pattern detection proposes a cart relation for a cart-badge tree and
 *    nothing for a bare page
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AxNode, AxSnapshot, NetworkEntry } from '../src/ports/browser-port.js';
import {
  blessBaseline,
  compareEnvironments,
  compareToBaseline,
  diffAxStructure,
  diffNetworkShape,
  loadBaseline,
  saveBaseline,
  type Baseline,
  type DiffMask,
} from '../src/assertions/differential.js';
import {
  addItemIncrementsCount,
  checkPaginationUnion,
  checkRelation,
  detectRelationCandidates,
  filterIsSubset,
  loginLogoutLoginReturnsToSameState,
  paginationPagesDisjoint,
  removeItemDecrementsCount,
  RELATIONS,
  sameUrlTwiceSameState,
  sortPreservesSet,
  type Observation,
} from '../src/assertions/metamorphic.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function ax(root: AxNode, truncated = false): AxSnapshot {
  return { root, text: '', truncated };
}

function listItems(n: number, prefix = 'Item'): AxNode[] {
  return Array.from({ length: n }, (_, i) => ({ id: `n${i}`, role: 'listitem', name: `${prefix} ${i + 1}` }));
}

function basePage(items: AxNode[]): AxSnapshot {
  return ax({
    id: 'n0',
    role: 'RootWebArea',
    name: 'Shop',
    children: [
      { id: 'n1', role: 'navigation', name: 'Main nav' },
      {
        id: 'n2',
        role: 'main',
        name: '',
        children: [{ id: 'n3', role: 'list', name: 'Products', children: items }],
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Tier 1: diffAxStructure
// ---------------------------------------------------------------------------

{
  const before = basePage(listItems(10));
  const after = basePage(listItems(11));
  const { changes } = diffAxStructure(before, after);
  check('10 -> 11 identically-shaped list items produces NO structural changes', changes.length === 0);
}

{
  const before = basePage(listItems(10));
  const afterRoot: AxNode = {
    id: 'n0',
    role: 'RootWebArea',
    name: 'Shop',
    children: [
      { id: 'n1', role: 'navigation', name: 'Main nav' },
      {
        id: 'n2',
        role: 'main',
        name: '',
        children: [{ id: 'n3', role: 'list', name: 'Products', children: listItems(10) }],
      },
      { id: 'n4', role: 'dialog', name: 'Confirm delete', children: [{ id: 'n5', role: 'button', name: 'Yes, delete' }] },
    ],
  };
  const after = ax(afterRoot);
  const { changes } = diffAxStructure(before, after);
  const added = changes.filter((c) => c.kind === 'added');
  check('an added modal is detected as an "added" change', added.some((c) => c.role === 'dialog'));
  check('no spurious changes beyond the modal (dialog + its button)', changes.every((c) => c.kind === 'added'));
}

{
  const before = basePage(listItems(3));
  const afterRoot: AxNode = {
    id: 'n0',
    role: 'RootWebArea',
    name: 'Shop',
    children: [
      { id: 'n2', role: 'main', name: '', children: [{ id: 'n3', role: 'list', name: 'Products', children: listItems(3) }] },
    ],
  };
  const after = ax(afterRoot);
  const { changes } = diffAxStructure(before, after);
  check('a removed region (nav) is detected as "removed"', changes.some((c) => c.kind === 'removed' && c.role === 'navigation'));
}

{
  const before = ax({
    id: 'n0',
    role: 'RootWebArea',
    name: 'Shop',
    children: [{ id: 'n1', role: 'text', name: 'Updated 2 minutes ago' }],
  });
  const after = ax({
    id: 'n0',
    role: 'RootWebArea',
    name: 'Shop',
    children: [{ id: 'n1', role: 'text', name: 'Updated 5 minutes ago' }],
  });

  const noMask = diffAxStructure(before, after);
  check('a timestamp diff fires without a mask', noMask.changes.length > 0);

  const masks: DiffMask[] = [{ role: 'text', pattern: /\d+ minutes? ago/i, label: 'relative-time' }];
  const masked = diffAxStructure(before, after, masks);
  check('the same timestamp diff is suppressed once masked', masked.changes.length === 0);
}

// ---------------------------------------------------------------------------
// Tier 1: diffNetworkShape
// ---------------------------------------------------------------------------

{
  const before: NetworkEntry[] = [
    { ts: 1, method: 'GET', url: 'https://shop.example.com/api/data', status: 200 },
    { ts: 2, method: 'GET', url: 'https://shop.example.com/api/config', status: 200 },
  ];
  const after: NetworkEntry[] = [{ ts: 1, method: 'GET', url: 'https://shop.example.com/api/data', status: 500, failed: true }];

  const diff = diffNetworkShape(before, after);
  check(
    'network-shape diff catches a status-class change',
    diff.statusClassChanges.some((c) => c.path.endsWith('/api/data') && c.before === '2xx' && c.after === '5xx'),
  );
  check(
    'network-shape diff catches a disappeared request',
    diff.removedRequests.some((r) => r.path.endsWith('/api/config')),
  );
  check('no spurious added requests', diff.addedRequests.length === 0);
}

{
  const before: NetworkEntry[] = [{ ts: 1, method: 'GET', url: 'https://shop.example.com/api/orders/12345', status: 200 }];
  const after: NetworkEntry[] = [{ ts: 1, method: 'GET', url: 'https://shop.example.com/api/orders/67890', status: 200 }];
  const diff = diffNetworkShape(before, after);
  check('numeric path segments are normalized (id churn does not look like added+removed)', diff.addedRequests.length === 0 && diff.removedRequests.length === 0);
}

// ---------------------------------------------------------------------------
// Tier 1: baseline store round-trip + bless
// ---------------------------------------------------------------------------

async function run() {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'spike-v48-baselines-'));
  try {
    const snapshotA = basePage(listItems(3));
    const networkA: NetworkEntry[] = [{ ts: 1, method: 'GET', url: 'https://shop.example.com/api/data', status: 200 }];

    const saved = await saveBaseline({ flow: 'checkout', createdAt: new Date(0).toISOString(), ax: snapshotA, network: networkA }, tmpDir);
    check('saveBaseline returns a file path under the given dir', saved.startsWith(tmpDir));

    const loaded = await loadBaseline('checkout', tmpDir);
    check('loadBaseline round-trips a saved baseline', loaded !== null && loaded.flow === 'checkout' && loaded.blessedAt === undefined);

    const missing = await loadBaseline('does-not-exist', tmpDir);
    check('loadBaseline returns null for a missing flow', missing === null);

    // compareToBaseline against itself: clean.
    const cleanCompare = compareToBaseline({ ax: snapshotA, network: networkA }, loaded as Baseline);
    check('compareToBaseline against an identical current observation is clean', cleanCompare.clean === true && cleanCompare.mode === 'baseline');

    // A real drift: add a modal.
    const snapshotB: AxSnapshot = ax({
      id: 'n0',
      role: 'RootWebArea',
      name: 'Shop',
      children: [
        { id: 'n1', role: 'navigation', name: 'Main nav' },
        { id: 'n2', role: 'main', name: '', children: [{ id: 'n3', role: 'list', name: 'Products', children: listItems(3) }] },
        { id: 'n4', role: 'dialog', name: 'Session expired' },
      ],
    });
    const driftCompare = compareToBaseline({ ax: snapshotB, network: networkA }, loaded as Baseline);
    check('compareToBaseline detects real drift against the baseline', driftCompare.clean === false && driftCompare.axChanges.some((c) => c.role === 'dialog'));

    // Bless the drifted snapshot as the new baseline.
    const blessed = await blessBaseline('checkout', { ax: snapshotB, network: networkA }, { dir: tmpDir });
    check('blessBaseline stamps blessedAt', typeof blessed.blessedAt === 'string' && blessed.blessedAt.length > 0);
    check('blessBaseline preserves the original createdAt', blessed.createdAt === new Date(0).toISOString());

    const reloaded = await loadBaseline('checkout', tmpDir);
    const afterBlessCompare = compareToBaseline({ ax: snapshotB, network: networkA }, reloaded as Baseline);
    check('after blessing, the previously-drifted snapshot now compares clean', afterBlessCompare.clean === true);

    // -------------------------------------------------------------------
    // compareEnvironments needs no baseline at all
    // -------------------------------------------------------------------
    const envA = { ax: snapshotA, network: networkA };
    const envB = { ax: snapshotA, network: networkA };
    const envClean = compareEnvironments(envA, envB);
    check('compareEnvironments on two identical live environments is clean, no baseline involved', envClean.clean === true && envClean.mode === 'environment');

    const envDrift = compareEnvironments(envA, { ax: snapshotB, network: networkA });
    check('compareEnvironments surfaces divergence between two live environments', envDrift.clean === false);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------
  // Tier 2: metamorphic relations
  // -------------------------------------------------------------------

  {
    const before: Observation = { counts: { cart: 2 } };
    const after: Observation = { counts: { cart: 3 } };
    check('add-item-increments-count: satisfied case is null', checkRelation(addItemIncrementsCount, before, after) === null);
  }
  {
    const before: Observation = { counts: { cart: 2 } };
    const after: Observation = { counts: { cart: 2 } };
    const violation = checkRelation(addItemIncrementsCount, before, after);
    check('add-item-increments-count: violated case is reported', violation?.relation === 'add-item-increments-count');
  }
  {
    const before: Observation = { counts: { cart: 3 } };
    const after: Observation = { counts: { cart: 2 } };
    check('remove-item-decrements-count: satisfied case is null', checkRelation(removeItemDecrementsCount, before, after) === null);
  }
  {
    const before: Observation = { counts: { cart: 3 } };
    const after: Observation = { counts: { cart: 3 } };
    check('remove-item-decrements-count: violated case is reported', checkRelation(removeItemDecrementsCount, before, after)?.relation === 'remove-item-decrements-count');
  }
  {
    const before: Observation = { items: ['a', 'b', 'c'] };
    const after: Observation = { items: ['c', 'a', 'b'] };
    check('sort-preserves-set: satisfied (reordered, same set)', checkRelation(sortPreservesSet, before, after) === null);
  }
  {
    const before: Observation = { items: ['a', 'b', 'c'] };
    const after: Observation = { items: ['a', 'b'] };
    check('sort-preserves-set: violated (item lost)', checkRelation(sortPreservesSet, before, after)?.relation === 'sort-preserves-set');
  }
  {
    const before: Observation = { items: ['a', 'b', 'c', 'd'] };
    const after: Observation = { items: ['b', 'c'] };
    check('filter-is-subset: satisfied (proper subset)', checkRelation(filterIsSubset, before, after) === null);
  }
  {
    const before: Observation = { items: ['a', 'b'] };
    const after: Observation = { items: ['a', 'z'] };
    check('filter-is-subset: violated (foreign item introduced)', checkRelation(filterIsSubset, before, after)?.relation === 'filter-is-subset');
  }
  {
    const page1: Observation = { items: ['a', 'b', 'c'] };
    const page2: Observation = { items: ['d', 'e', 'f'] };
    check('pagination-pages-disjoint: satisfied (no overlap)', checkRelation(paginationPagesDisjoint, page1, page2) === null);
  }
  {
    const page1: Observation = { items: ['a', 'b', 'c'] };
    const page2: Observation = { items: ['c', 'd', 'e'] };
    check('pagination-pages-disjoint: violated (overlap)', checkRelation(paginationPagesDisjoint, page1, page2)?.relation === 'pagination-pages-disjoint');
  }
  {
    const pages = [
      ['a', 'b'],
      ['c', 'd'],
      ['e'],
    ];
    check('checkPaginationUnion: satisfied (union equals whole)', checkPaginationUnion(pages, ['a', 'b', 'c', 'd', 'e']) === null);
    check('checkPaginationUnion: violated (missing item)', checkPaginationUnion(pages, ['a', 'b', 'c', 'd', 'e', 'f'])?.relation === 'pagination-union-is-whole');
  }
  {
    const before: Observation = { state: { loggedInAs: 'alice', cart: ['x'] } };
    const after: Observation = { state: { loggedInAs: 'alice', cart: ['x'] } };
    check('login-logout-login-same-state: satisfied', checkRelation(loginLogoutLoginReturnsToSameState, before, after) === null);
  }
  {
    const before: Observation = { state: { loggedInAs: 'alice', cart: ['x'] } };
    const after: Observation = { state: { loggedInAs: 'alice', cart: [] } };
    check('login-logout-login-same-state: violated (cart lost on re-login)', checkRelation(loginLogoutLoginReturnsToSameState, before, after)?.relation === 'login-logout-login-same-state');
  }
  {
    const before: Observation = { url: 'https://shop.example.com/products', state: { count: 12 } };
    const after: Observation = { url: 'https://shop.example.com/products', state: { count: 12 } };
    check('same-url-twice-same-state: satisfied', checkRelation(sameUrlTwiceSameState, before, after) === null);
  }
  {
    const before: Observation = { url: 'https://shop.example.com/products', state: { count: 12 } };
    const after: Observation = { url: 'https://shop.example.com/products', state: { count: 9 } };
    check('same-url-twice-same-state: violated (state differs)', checkRelation(sameUrlTwiceSameState, before, after)?.relation === 'same-url-twice-same-state');
  }
  {
    const before: Observation = { url: 'https://shop.example.com/a' };
    const after: Observation = { url: 'https://shop.example.com/b' };
    check('same-url-twice-same-state: not applicable when URLs differ, still reports (not silently null)', checkRelation(sameUrlTwiceSameState, before, after) !== null);
  }

  check('RELATIONS library exposes all 7 relations', RELATIONS.length === 7);
  check('every relation has a stable kebab-case id', RELATIONS.every((r) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(r.id)));
  check('confidence is split reliable/speculative honestly', RELATIONS.filter((r) => r.confidence === 'reliable').length === 5 && RELATIONS.filter((r) => r.confidence === 'speculative').length === 2);

  // -------------------------------------------------------------------
  // Tier 2: pattern detection
  // -------------------------------------------------------------------

  {
    const cartTree: AxSnapshot = ax({
      id: 'n0',
      role: 'RootWebArea',
      name: 'Shop',
      children: [
        { id: 'n1', role: 'navigation', name: 'Main nav' },
        { id: 'n2', role: 'button', name: 'Cart (3)' },
        { id: 'n3', role: 'main', name: '', children: listItems(3) },
      ],
    });
    const proposals = detectRelationCandidates(cartTree);
    check('pattern detection proposes a cart relation for a cart-badge tree', proposals.some((p) => p.relation.id === 'add-item-increments-count'));
    check('pattern detection also proposes the inverse (remove) relation', proposals.some((p) => p.relation.id === 'remove-item-decrements-count'));
  }

  {
    const barePage: AxSnapshot = ax({
      id: 'n0',
      role: 'RootWebArea',
      name: 'About us',
      children: [
        { id: 'n1', role: 'heading', name: 'About us' },
        { id: 'n2', role: 'text', name: 'We build things.' },
      ],
    });
    const proposals = detectRelationCandidates(barePage);
    check('pattern detection proposes nothing for a bare page', proposals.length === 0);
  }

  {
    const sortableTree: AxSnapshot = ax({
      id: 'n0',
      role: 'RootWebArea',
      name: 'Table',
      children: [{ id: 'n1', role: 'columnheader', name: 'Sort by price', states: ['sortable'] }],
    });
    const proposals = detectRelationCandidates(sortableTree);
    check('pattern detection proposes a sort relation for a sortable column header', proposals.some((p) => p.relation.id === 'sort-preserves-set'));
  }

  {
    const paginatorTree: AxSnapshot = ax({
      id: 'n0',
      role: 'RootWebArea',
      name: 'List',
      children: [{ id: 'n1', role: 'link', name: 'Next' }],
    });
    const proposals = detectRelationCandidates(paginatorTree);
    check('pattern detection proposes a pagination relation for a "Next" control', proposals.some((p) => p.relation.id === 'pagination-pages-disjoint'));
  }

  {
    const filterTree: AxSnapshot = ax({
      id: 'n0',
      role: 'RootWebArea',
      name: 'List',
      children: [{ id: 'n1', role: 'checkbox', name: 'Filter: in stock only' }],
    });
    const proposals = detectRelationCandidates(filterTree);
    check('pattern detection proposes a filter relation for a filter checkbox', proposals.some((p) => p.relation.id === 'filter-is-subset'));
  }

  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length) {
    console.error(`\n${failed.length} checks failed:`);
    for (const [label] of failed) console.error(` - ${label}`);
    process.exit(1);
  }

  console.log(`\nV48 oracle checks passed (${checks.length}).`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
