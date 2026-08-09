/* V50 — A8 (P1): testid-first locators + scored disambiguation instead of a
 * hard fail on ambiguity.
 *
 * Pure unit coverage, no Chrome/model calls: AxNode trees and ScriptTargets
 * are built in memory, and replay's resolution logic is exercised directly
 * via the exported `resolveTargetInTree` pure helper (never through the
 * async `findByTarget`/polling wrapper, which needs a live BrowserPort).
 *
 * Covers:
 *   1. testid wins over role+name when both are present on the page.
 *   2. a legacy target (role+name only, no candidates/testid) resolves
 *      exactly as before — unambiguous case unaffected.
 *   3. ambiguity with a clear positional/landmark/sibling-text winner
 *      resolves instead of hard-failing.
 *   4. ambiguity with two EQUALLY-good candidates still fails explicitly —
 *      never silently guess.
 *   5. the candidate stack (LocatorCandidate[]) round-trips through the zod
 *      schema, and a pre-A8 script (no candidates/testid at all) still
 *      validates unmodified.
 *   6. axtree.ts's serializeAxTree no-options output is still byte-identical
 *      (guards against the A8 AxNode.testId addition leaking into the
 *      planner-facing text — it must not).
 *
 * Run: npx tsx test/v50.locators.ts
 */

import type { AxNode } from '../src/ports/browser-port.js';
import { serializeAxTree } from '../src/capture/axtree.js';
import { resolveTargetInTree } from '../src/recorder/replay.js';
import { candidateStackFor } from '../src/recorder/script.js';
import type { LocatorCandidate, QaScript, ScriptTarget } from '../src/recorder/script.js';
import { validateQaScript, ScriptTargetSchema, LocatorCandidateSchema } from '../src/recorder/schema.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

/* ===================== 1. testid wins over role+name ===================== */
{
  // Two "Delete" buttons — one carries a testid, the OTHER is what role+name
  // alone would ambiguously match too. A target whose candidate stack leads
  // with testid must land on the testid'd node even though it's also a
  // perfectly valid (if ambiguous) role+name match.
  const tree: AxNode = {
    id: 'n0',
    role: 'RootWebArea',
    children: [
      { id: 'n1', role: 'button', name: 'Delete', testId: 'row-2-delete' },
      { id: 'n2', role: 'button', name: 'Delete' },
    ],
  };
  const target: ScriptTarget = {
    role: 'button',
    name: 'Delete',
    candidates: [
      { kind: 'testid', value: 'row-2-delete' },
      { kind: 'role', role: 'button', name: 'Delete' },
    ],
  };
  const resolution = resolveTargetInTree(tree, target);
  check(
    'testid candidate resolves before role+name is ever consulted',
    resolution.status === 'found' && resolution.node.id === 'n1' && resolution.via === 'testid',
  );
}

/* ===================== 2. legacy target resolves exactly as before ===================== */
{
  // No `candidates`, no `testId` — the exact shape every script recorded
  // before A8 has. Unambiguous role+name must resolve to the sole match,
  // same as the pre-A8 `findByTarget`.
  const tree: AxNode = {
    id: 'n0',
    role: 'RootWebArea',
    children: [
      { id: 'n1', role: 'button', name: 'Sign in' },
      { id: 'n2', role: 'textbox', name: 'Email' },
    ],
  };
  const legacyTarget: ScriptTarget = { role: 'button', name: 'Sign in' };
  check(
    'candidateStackFor() synthesizes exactly [role+name] for a legacy target with no qaId',
    JSON.stringify(candidateStackFor(legacyTarget)) === JSON.stringify([{ kind: 'role', role: 'button', name: 'Sign in', nth: undefined }]),
  );
  const resolution = resolveTargetInTree(tree, legacyTarget);
  check(
    'legacy target (role+name only) resolves to the sole match, exactly as before',
    resolution.status === 'found' && resolution.node.id === 'n1' && resolution.via === 'role',
  );

  // A legacy target that also carries qaId — stack must be [role, qaId], the
  // pre-A8 fallback order.
  const legacyWithQaId: ScriptTarget = { role: 'button', name: 'Checkout', qaId: 'qa-abc123' };
  const stack = candidateStackFor(legacyWithQaId);
  check(
    'candidateStackFor() synthesizes [role+name, qaId] for a legacy target WITH qaId, in that order',
    stack.length === 2 && stack[0].kind === 'role' && stack[1].kind === 'qaId' && (stack[1] as { value: string }).value === 'qa-abc123',
  );

  // A legacy target with a recorded nth, unambiguous in range — must still
  // resolve directly by index, no scoring involved.
  const listTree: AxNode = {
    id: 'n0',
    role: 'RootWebArea',
    children: [
      { id: 'n1', role: 'link', name: 'Edit' },
      { id: 'n2', role: 'link', name: 'Edit' },
      { id: 'n3', role: 'link', name: 'Edit' },
    ],
  };
  const nthTarget: ScriptTarget = { role: 'link', name: 'Edit', nth: 2 };
  const nthResolution = resolveTargetInTree(listTree, nthTarget);
  check(
    'legacy target with an in-range nth resolves to that exact index, as before',
    nthResolution.status === 'found' && nthResolution.node.id === 'n3',
  );
}

/* ===================== 3. ambiguity with a clear winner resolves ===================== */
{
  // Two identical "Delete" buttons under two different table rows. The
  // target carries a landmark hint (row named "Order #2") that matches only
  // ONE of the two live candidates — a clear, scoreable winner.
  const tree: AxNode = {
    id: 'n0',
    role: 'RootWebArea',
    children: [
      {
        id: 'n1',
        role: 'row',
        name: 'Order #1',
        children: [{ id: 'n2', role: 'button', name: 'Delete' }],
      },
      {
        id: 'n3',
        role: 'row',
        name: 'Order #2',
        children: [{ id: 'n4', role: 'button', name: 'Delete' }],
      },
    ],
  };
  const target: ScriptTarget = {
    role: 'button',
    name: 'Delete',
    candidates: [{ kind: 'role', role: 'button', name: 'Delete', landmark: { role: 'row', name: 'Order #2' } }],
  };
  const resolution = resolveTargetInTree(tree, target);
  check(
    'ambiguous role+name with a matching landmark hint resolves to the correct row, not a hard fail',
    resolution.status === 'found' && resolution.node.id === 'n4' && resolution.via === 'role',
  );

  // Same shape, but disambiguated by sibling text instead of a landmark.
  // Each SKU/button pair is grouped under its OWN container so the two
  // buttons don't share a sibling list — otherwise "sibling text" would
  // trivially match both (a flat list under one parent has every node as
  // every other node's sibling).
  const siblingTree: AxNode = {
    id: 'n0',
    role: 'RootWebArea',
    children: [
      {
        id: 'g1',
        role: 'listitem',
        children: [
          { id: 'n1', role: 'StaticText', name: 'SKU-111' },
          { id: 'n2', role: 'button', name: 'Edit' },
        ],
      },
      {
        id: 'g2',
        role: 'listitem',
        children: [
          { id: 'n3', role: 'StaticText', name: 'SKU-222' },
          { id: 'n4', role: 'button', name: 'Edit' },
        ],
      },
    ],
  };
  const siblingTarget: ScriptTarget = {
    role: 'button',
    name: 'Edit',
    candidates: [{ kind: 'role', role: 'button', name: 'Edit', siblingText: 'SKU-222' }],
  };
  const siblingResolution = resolveTargetInTree(siblingTree, siblingTarget);
  check(
    'ambiguous role+name with a matching sibling-text hint resolves to the correct sibling group',
    siblingResolution.status === 'found' && siblingResolution.node.id === 'n4',
  );

  // A recorded nth that's now OUT OF RANGE (virtualised list shifted) but
  // still clearly closest to one of the remaining matches.
  const shiftedTree: AxNode = {
    id: 'n0',
    role: 'RootWebArea',
    children: [
      { id: 'n1', role: 'link', name: 'Row' },
      { id: 'n2', role: 'link', name: 'Row' },
      { id: 'n3', role: 'link', name: 'Row' },
    ],
  };
  const shiftedTarget: ScriptTarget = { role: 'link', name: 'Row', nth: 4 }; // was 5th, only 3 remain
  const shiftedResolution = resolveTargetInTree(shiftedTree, shiftedTarget);
  check(
    'an out-of-range nth resolves to the positionally-closest remaining match instead of failing outright',
    shiftedResolution.status === 'found' && shiftedResolution.node.id === 'n3',
  );
}

/* ===================== 4. two equally-good candidates still FAIL ===================== */
{
  // Two identical "Delete" buttons, no nth, no landmark hint, no sibling
  // hint — genuinely no distinguishing signal. Must fail explicitly, not
  // guess (this is also exactly the legacy/no-candidates ambiguity shape).
  const tree: AxNode = {
    id: 'n0',
    role: 'RootWebArea',
    children: [
      { id: 'n1', role: 'button', name: 'Delete' },
      { id: 'n2', role: 'button', name: 'Delete' },
    ],
  };
  const legacyAmbiguous: ScriptTarget = { role: 'button', name: 'Delete' };
  const resolution = resolveTargetInTree(tree, legacyAmbiguous);
  check(
    'ambiguous legacy target with NO disambiguation signal fails explicitly (never silently guesses)',
    resolution.status === 'ambiguous' && /ambiguous locator/.test(resolution.detail),
  );

  // Same, but WITH a landmark hint that matches BOTH candidates equally (both
  // under identical "row" landmarks with no name) — still a tie, still fails.
  const tiedTree: AxNode = {
    id: 'n0',
    role: 'RootWebArea',
    children: [
      { id: 'n1', role: 'row', children: [{ id: 'n2', role: 'button', name: 'Delete' }] },
      { id: 'n3', role: 'row', children: [{ id: 'n4', role: 'button', name: 'Delete' }] },
    ],
  };
  const tiedTarget: ScriptTarget = {
    role: 'button',
    name: 'Delete',
    candidates: [{ kind: 'role', role: 'button', name: 'Delete', landmark: { role: 'row' } }],
  };
  const tiedResolution = resolveTargetInTree(tiedTree, tiedTarget);
  check(
    'a landmark hint that matches every candidate EQUALLY is a tie, and still fails explicitly',
    tiedResolution.status === 'ambiguous',
  );

  // Zero matches anywhere — must be 'absent' (worth polling for), not 'ambiguous'.
  const emptyTree: AxNode = { id: 'n0', role: 'RootWebArea', children: [] };
  const absentResolution = resolveTargetInTree(emptyTree, { role: 'button', name: 'Nope' });
  check('zero matches resolves to "absent" (pollable), not "ambiguous"', absentResolution.status === 'absent');
}

/* ===================== 5. candidate stack round-trips through the zod schema ===================== */
{
  const candidates: LocatorCandidate[] = [
    { kind: 'testid', value: 'checkout-submit' },
    { kind: 'role', role: 'button', name: 'Place order', nth: 0, landmark: { role: 'form', name: 'Checkout' }, siblingText: 'Total: $42.00' },
    { kind: 'qaId', value: 'qa-9f8e7d' },
    { kind: 'text', value: 'Place order' },
  ];
  for (const c of candidates) {
    const result = LocatorCandidateSchema.safeParse(c);
    check(`LocatorCandidate(${c.kind}) validates against LocatorCandidateSchema`, result.success);
  }

  const targetWithStack: ScriptTarget = { role: 'button', name: 'Place order', candidates };
  const targetResult = ScriptTargetSchema.safeParse(targetWithStack);
  check('a ScriptTarget carrying a full candidate stack validates against ScriptTargetSchema', targetResult.success);
  if (targetResult.success) {
    check(
      'the validated target round-trips the candidate stack unmodified',
      JSON.stringify(targetResult.data.candidates) === JSON.stringify(candidates),
    );
  }

  // A malformed candidate (unknown key) must be rejected — .strict() applies
  // to LocatorCandidate branches too.
  const malformed = { kind: 'testid', value: 'x', extra: 'nope' };
  check('an unknown key on a candidate is rejected (.strict())', !LocatorCandidateSchema.safeParse(malformed).success);

  // A pre-A8 script (no candidates/testId anywhere) still validates unmodified
  // — the whole point of "additive".
  const legacyScript: QaScript = {
    version: 1,
    name: 'legacy-login',
    task: 'log in',
    url: 'http://localhost:9401/',
    sourceRunId: 'run-legacy',
    createdAt: '2026-01-01T00:00:00.000Z',
    steps: [
      { type: 'navigate', url: 'http://localhost:9401/' },
      { type: 'click', target: { role: 'button', name: 'Sign in' } },
      { type: 'type', target: { role: 'textbox', name: 'Email' }, text: 'a@example.com' },
      { type: 'assert_dom', target: { role: 'heading', name: 'Home' }, contains: 'Home' },
    ],
  };
  const legacyResult = validateQaScript(legacyScript);
  check('a pre-A8 script (no candidates/testId at all) still validates unmodified', legacyResult.ok);
}

/* ===================== 6. serializeAxTree no-options output stays byte-identical ===================== */
{
  // A tree with a testId set on one node — the new AxNode field must never
  // leak into the planner-facing serialized text (token budget, and the v46
  // regression guard both depend on this).
  const withTestId: AxNode = {
    id: 'n0',
    role: 'RootWebArea',
    children: [
      { id: 'n1', role: 'button', name: 'Place order', testId: 'checkout-submit' },
      { id: 'n2', role: 'textbox', name: 'Email' },
    ],
  };
  const withoutTestId: AxNode = {
    id: 'n0',
    role: 'RootWebArea',
    children: [
      { id: 'n1', role: 'button', name: 'Place order' },
      { id: 'n2', role: 'textbox', name: 'Email' },
    ],
  };
  const a = serializeAxTree(withTestId);
  const b = serializeAxTree(withoutTestId);
  check('serializeAxTree() output is identical whether or not a node carries testId', a.text === b.text && a.truncated === b.truncated);
  check('serialized text never leaks the literal testid value', !a.text.includes('checkout-submit'));
}

/* ===================== summary ===================== */

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  console.error(`\n${failed.length} checks failed:`);
  for (const [label] of failed) console.error(` - ${label}`);
  process.exit(1);
}

console.log(`\nV50 locator checks passed (${checks.length}).`);
process.exit(0);
