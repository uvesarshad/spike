/* V46 — A19 (region-focused AX serialization) + A16 (honest .spec.ts twin).
 *
 * Pure unit coverage, no Chrome/model calls: AxNode trees and QaScript
 * objects are built in memory. Covers:
 *
 *  A19 (src/capture/axtree.ts):
 *   - default (no focus hint) serialization is BYTE-IDENTICAL to the
 *     pre-change global-truncation algorithm, for both an under-budget and
 *     an over-budget tree — guards against regressions in ids/text/elision.
 *   - a focus hint keeps the focused subtree intact (every id under it
 *     survives) while the rest of the page is summarised/elided under a
 *     tight budget.
 *   - truncated is set correctly (true when content exceeds the budget,
 *     false when it fits) in both the flat and focused paths.
 *   - an unmatched focus hint (unknown id/role) degrades to the exact same
 *     output as no focus hint at all — never worse than not supplying one.
 *   - ids are never renumbered/duplicated by serialization.
 *
 *  A16 (src/recorder/script.ts, toPlaywrightSpec only):
 *   - the emitted file is syntactically valid TypeScript.
 *   - the `assert_visual` no-op `expect(page.locator('body')).toBeVisible()`
 *     is gone, replaced by a `// TODO(assertion): <expectation>` line.
 *   - the header honestly frames the file as a non-runnable translation and
 *     points at `spike replay` as the executable form.
 *
 * Run: npx tsx test/v46.axtree-spec.ts
 */

import ts from 'typescript';
import type { AxNode } from '../src/ports/browser-port.js';
import { serializeAxTree } from '../src/capture/axtree.js';
import { toPlaywrightSpec } from '../src/recorder/script.js';
import type { QaScript } from '../src/recorder/script.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

/* ===================== A19: region-focused AX serialization ===================== */

/** A straight, independent re-implementation of the PRE-A19 global-truncation
 * algorithm (keep first 40% of lines + as much tail as fits the remaining
 * budget, single elision marker in between). Used as an oracle: whatever
 * `serializeAxTree()` does with no focus hint must match this EXACTLY, for
 * any tree, at any budget. If this test ever fails, either a real regression
 * was introduced, or (much less likely) both this oracle and the production
 * code drifted the same way — worth a second look either way. */
function legacySerialize(root: AxNode, maxChars: number): { text: string; truncated: boolean } {
  const lines: string[] = [];
  const walk = (n: AxNode, depth: number) => {
    const parts: (string | undefined)[] = [n.id, n.role];
    if (n.name) parts.push(JSON.stringify(n.name));
    if (n.value) parts.push(`value=${JSON.stringify(n.value)}`);
    if (n.states?.length) parts.push(`(${n.states.join(', ')})`);
    lines.push('  '.repeat(depth) + parts.join(' '));
    for (const c of n.children ?? []) walk(c, depth + 1);
  };
  walk(root, 0);

  let text = lines.join('\n');
  let truncated = false;
  if (text.length > maxChars) {
    const head = lines.slice(0, Math.floor(lines.length * 0.4));
    const keepChars = maxChars - head.join('\n').length - 64;
    const tail: string[] = [];
    let used = 0;
    for (let i = lines.length - 1; i >= head.length && used < keepChars; i--) {
      used += lines[i].length + 1;
      tail.unshift(lines[i]);
    }
    text = [...head, `  … (${lines.length - head.length - tail.length} nodes truncated) …`, ...tail].join('\n');
    truncated = true;
  }
  return { text, truncated };
}

/** Small fixture — well under any realistic budget, so no truncation should
 * ever fire. Ids are hand-assigned in DFS pre-order, mirroring how
 * `snapshotAxTree`'s `build()` numbers kept nodes. */
const smallFixture: AxNode = {
  id: 'n0',
  role: 'RootWebArea',
  children: [
    {
      id: 'n1',
      role: 'navigation',
      children: [
        { id: 'n2', role: 'link', name: 'Home' },
        { id: 'n3', role: 'link', name: 'Products' },
      ],
    },
    {
      id: 'n4',
      role: 'main',
      children: [
        { id: 'n5', role: 'heading', name: 'Checkout' },
        { id: 'n6', role: 'textbox', name: 'Email', value: '' },
        { id: 'n7', role: 'button', name: 'Place order', states: ['disabled'] },
      ],
    },
  ],
};

/** Wide+deep fixture used to force truncation without needing a literal
 * ~6000-char tree — `serializeAxTree`'s `maxChars` is caller-overridable, so
 * a small budget over a modest tree exercises the same code path. */
function buildWideFixture(navLinks: number, mainRows: number): AxNode {
  let seq = 0;
  const id = () => `n${seq++}`;
  const nav: AxNode = {
    id: id(),
    role: 'navigation',
    name: 'Primary',
    children: Array.from({ length: navLinks }, (_, i) => ({ id: id(), role: 'link', name: `Nav item ${i}` })),
  };
  const main: AxNode = {
    id: id(),
    role: 'main',
    name: 'Order summary',
    children: Array.from({ length: mainRows }, (_, i) => ({ id: id(), role: 'row', name: `Line item ${i}` })),
  };
  const aside: AxNode = {
    id: id(),
    role: 'complementary',
    name: 'Related',
    children: Array.from({ length: navLinks }, (_, i) => ({ id: id(), role: 'link', name: `Related ${i}` })),
  };
  return { id: id(), role: 'RootWebArea', children: [nav, main, aside] };
}

// -- default path is byte-identical: under-budget tree --
{
  const got = serializeAxTree(smallFixture);
  const want = legacySerialize(smallFixture, 6000); // MAX_CHARS default
  check('no-focus, under budget: text is byte-identical to the pre-A19 algorithm', got.text === want.text);
  check('no-focus, under budget: truncated is false', got.truncated === false && want.truncated === false);
}

// -- default path is byte-identical: over-budget tree, default budget path exercised via caller-supplied maxChars --
{
  const wide = buildWideFixture(60, 60);
  const got = serializeAxTree(wide, { maxChars: 500 });
  const want = legacySerialize(wide, 500);
  check('no-focus, over budget: text is byte-identical to the pre-A19 algorithm', got.text === want.text);
  check('no-focus, over budget: truncated is true', got.truncated === true && want.truncated === true);
}

// -- an unmatched focus hint degrades to exactly the no-focus output --
{
  const wide = buildWideFixture(40, 40);
  const withUnmatchedFocus = serializeAxTree(wide, { maxChars: 400, focus: { role: 'dialog', name: 'nope' } });
  const withoutFocus = serializeAxTree(wide, { maxChars: 400 });
  check(
    'unmatched focus hint (absent landmark) falls back byte-identically to no-focus output',
    withUnmatchedFocus.text === withoutFocus.text && withUnmatchedFocus.truncated === withoutFocus.truncated,
  );
}

// -- focus hint keeps the focused subtree intact while shrinking the rest --
{
  const wide = buildWideFixture(80, 5); // huge nav, small main — nav must be the thing that shrinks
  const full = serializeAxTree(wide); // no budget pressure at all, for a baseline of "everything present"
  const focusedTiny = serializeAxTree(wide, { maxChars: 300, focus: { role: 'main', name: 'Order summary' } });

  // every id under the focused "main" subtree must survive verbatim
  const mainNode = wide.children!.find((c) => c.role === 'main')!;
  const mainIds: string[] = [];
  (function collect(n: AxNode) {
    mainIds.push(n.id);
    for (const c of n.children ?? []) collect(c);
  })(mainNode);
  const allMainIdsPresent = mainIds.every((id) => new RegExp(`(^|\\n)\\s*${id} `).test(focusedTiny.text));
  check('focus hint: every id in the focused subtree survives truncation', allMainIdsPresent);

  check('focus hint: truncated is true under a tight budget', focusedTiny.truncated === true);
  check(
    'focus hint: output is smaller than the unbudgeted full serialization (the nav actually shrank)',
    focusedTiny.text.length < full.text.length,
  );
  check(
    'focus hint: the huge nav is NOT emitted verbatim (elided/summarised)',
    !wide.children!.find((c) => c.role === 'navigation')!.children!.every((c) => focusedTiny.text.includes(c.id)),
  );
}

// -- focus hint under a generous budget: nothing needs truncating, so focus is a no-op --
{
  const got = serializeAxTree(smallFixture, { focus: { role: 'main' } });
  const want = serializeAxTree(smallFixture); // budget never binds — focus vs no-focus must agree
  check('focus hint under a generous budget matches the unfocused output (focus only matters once truncation fires)', got.text === want.text && got.truncated === false);
}

// -- focus by exact node id --
{
  const wide = buildWideFixture(80, 5);
  const target = wide.children!.find((c) => c.role === 'main')!.children![0]!; // a single row deep in main
  const focused = serializeAxTree(wide, { maxChars: 250, focus: { id: target.id } });
  check(`focus-by-id (${target.id}) keeps that exact node in the output`, new RegExp(`(^|\\n)\\s*${target.id} `).test(focused.text));
}

// -- ids stay stable and unique across a serialization --
{
  const wide = buildWideFixture(10, 10);
  const allIds: string[] = [];
  (function collect(n: AxNode) {
    allIds.push(n.id);
    for (const c of n.children ?? []) collect(c);
  })(wide);
  check('fixture ids are unique to begin with (sanity)', new Set(allIds).size === allIds.length);

  const { text } = serializeAxTree(wide); // generous default budget — every id should round-trip
  const idsInOutput = [...text.matchAll(/(^|\n)\s*(n\d+) /g)].map((m) => m[2]);
  check('serialization preserves every input id (no renumbering)', idsInOutput.length === allIds.length && allIds.every((id) => idsInOutput.includes(id)));
  check('serialization never duplicates an id', new Set(idsInOutput).size === idsInOutput.length);
}

/* ===================== A16: honest, non-runnable .spec.ts twin ===================== */

const spikeScript: QaScript = {
  version: 1,
  name: 'checkout-flow',
  task: 'log in and place an order',
  url: 'http://localhost:9401/',
  sourceRunId: '2026-08-09_12-19-05-xgx6',
  createdAt: '2026-08-09T12:19:05.000Z',
  steps: [
    { type: 'navigate', url: 'http://localhost:9401/' },
    { type: 'click', target: { role: 'button', name: 'Sign in' } },
    { type: 'type', target: { role: 'textbox', name: 'Email' }, text: 'a@example.com' },
    { type: 'assert_dom', target: { role: 'heading', name: 'Products' }, contains: 'Products' },
    {
      type: 'assert_visual',
      expectation: 'The task "log in and place an order" should have completed successfully.\nNo error banners, no blank page.',
    },
  ],
};

const spec = toPlaywrightSpec(spikeScript);

{
  check('emitted spec does not contain the old toBeVisible() no-op assertion', !spec.includes('toBeVisible()'));
  check(
    'emitted spec carries the real expectation text as a TODO(assertion) comment',
    spec.includes('// TODO(assertion): The task "log in and place an order" should have completed successfully. No error banners, no blank page.'),
  );
  check('emitted spec still points at `spike replay <name>` as the executable form', spec.includes('spike replay checkout-flow'));
  check('emitted spec header honestly states it is not a runnable test', /not (a )?runnable/i.test(spec) || /reference rendering/i.test(spec));
  check('emitted spec still contains a real, failable assertion for assert_dom', spec.includes('.toContainText('));
}

// -- syntactic validity: the file must parse as TypeScript with zero syntax errors --
{
  const result = ts.transpileModule(spec, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
      strict: true,
    },
    fileName: 'checkout-flow.spec.ts',
    reportDiagnostics: true,
  });
  const syntaxErrors = (result.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (syntaxErrors.length) {
    for (const d of syntaxErrors) {
      console.error('  syntax error:', ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    }
  }
  check('emitted spec is syntactically valid TypeScript', syntaxErrors.length === 0);
}

/* ===================== summary ===================== */

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  console.error(`\n${failed.length} checks failed:`);
  for (const [label] of failed) console.error(` - ${label}`);
  process.exit(1);
}

console.log(`\nV46 axtree/spec checks passed (${checks.length}).`);
