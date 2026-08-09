/* a11y-tree extraction — the token-cheap "eyes" of the driver loop.
 *
 * Accessibility.getFullAXTree → pruned to interactive/landmark/named nodes →
 * compact indented text with per-snapshot stable ids (n0, n1, …) the planner
 * references in actions, plus an id → backendDOMNodeId map for the executor.
 * Target ~800 tokens/page (PinchTab-class); hard guard at ~1.5K tokens. */

import type CDP from 'chrome-remote-interface';
import type { AxNode, AxSnapshot } from '../ports/browser-port.js';

/** ~4 chars/token heuristic; guard at ~1.5K tokens. */
const MAX_CHARS = 6000;

/** Hard cap on recursion depth for both the raw-tree walk (`build`) and the
 * serialized-tree walk (`serializeAxTree`'s `walk`) — a pathologically deep DOM
 * (some SPA component trees nest hundreds of levels) should stop descending
 * here rather than relying solely on the post-walk MAX_CHARS truncation.
 * Generous enough that real pages never hit it. */
const MAX_DEPTH = 200;

const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox',
  'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'slider', 'switch', 'spinbutton',
]);

const STRUCTURAL = new Set([
  'RootWebArea', 'banner', 'navigation', 'main', 'contentinfo', 'complementary',
  'form', 'region', 'search', 'heading', 'table', 'row', 'cell', 'columnheader',
  'rowheader', 'list', 'listitem', 'image', 'img', 'alert', 'alertdialog',
  'dialog', 'status', 'article', 'figure',
]);

const STATE_PROPS = new Set(['disabled', 'focused', 'required', 'checked', 'expanded', 'invalid', 'selected']);

interface RawAxNode {
  nodeId: string;
  ignored: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: string };
  properties?: { name: string; value?: { value?: unknown } }[];
  childIds?: string[];
  backendDOMNodeId?: number;
  parentId?: string;
}

/** A8 (P1): the handful of `data-*` attributes projects commonly use to mark a
 * stable, test-only hook on an element. First one present on a node wins, in
 * this priority order — `data-testid` is by far the most common convention
 * (Testing Library et al.), the rest are aliases seen in the wild. Exported so
 * `CdpBrowser.findByTestId`'s live-DOM fallback tries the exact same
 * attributes in the exact same priority order as the snapshot capture below —
 * one list, never two that can drift apart. */
export const TESTID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa'];

/** Minimal shape of a `DOM.getDocument({depth:-1, pierce:true})` node — only
 * the fields the testid walk needs. `attributes` is CDP's flat
 * [name1, value1, name2, value2, …] encoding. `contentDocument` covers
 * same-process iframes; `shadowRoots` covers open shadow DOM — both are
 * walked so a testid inside either is still found. */
interface DomAttrNode {
  backendNodeId?: number;
  attributes?: string[];
  children?: DomAttrNode[];
  contentDocument?: DomAttrNode;
  shadowRoots?: DomAttrNode[];
}

function extractTestId(attributes?: string[]): string | undefined {
  if (!attributes) return undefined;
  const byName = new Map<string, string>();
  for (let i = 0; i + 1 < attributes.length; i += 2) byName.set(attributes[i].toLowerCase(), attributes[i + 1]);
  for (const attr of TESTID_ATTRS) {
    const v = byName.get(attr);
    if (v) return v;
  }
  return undefined;
}

/** Walk a `DOM.getDocument` tree ONCE and index every testid by backendNodeId
 * — a single bulk pass per snapshot, not a per-node round-trip. */
function buildTestIdMap(root: DomAttrNode): Map<number, string> {
  const map = new Map<number, string>();
  const walk = (n: DomAttrNode): void => {
    if (n.backendNodeId !== undefined) {
      const testId = extractTestId(n.attributes);
      if (testId) map.set(n.backendNodeId, testId);
    }
    for (const c of n.children ?? []) walk(c);
    if (n.contentDocument) walk(n.contentDocument);
    for (const sr of n.shadowRoots ?? []) walk(sr);
  };
  walk(root);
  return map;
}

export interface AxTreeResult {
  snapshot: AxSnapshot;
  nodeMap: Map<string, number>;
}

/** A19: focus a serialization on one subtree instead of blind global
 * truncation. Matched against the ALREADY-PRUNED `AxNode` tree (the same one
 * whose ids the planner already speaks in), not the raw CDP nodes.
 *
 * `id` (a stable `n7`-style id from a prior snapshot) takes priority and is an
 * exact match. Otherwise `role` (a landmark role, e.g. `navigation`/`main`)
 * is required and `name` narrows it further — exact match first, falling
 * back to a case-insensitive substring match (AX names are often longer than
 * what a caller can quote verbatim, e.g. a `main` region named after the page
 * title). No match found (unknown id, absent landmark) → silently degrades to
 * the default global-truncation path; a focus hint can never make output
 * worse than not supplying one. */
export interface AxFocusHint {
  id?: string;
  role?: string;
  name?: string;
}

export interface SerializeAxTreeOptions {
  /** Caller-supplied character budget. Defaults to `MAX_CHARS` (6000). */
  maxChars?: number;
  focus?: AxFocusHint;
}

interface AxLineEntry {
  id: string;
  role: string;
  name?: string;
  text: string;
  /** Ids of every ancestor from the root down to (not including) this node. */
  ancestors: string[];
}

function findFocusEntry(entries: AxLineEntry[], focus: AxFocusHint): AxLineEntry | undefined {
  if (focus.id) return entries.find((e) => e.id === focus.id);
  if (!focus.role) return undefined;
  const exact = entries.find((e) => e.role === focus.role && (focus.name === undefined || e.name === focus.name));
  if (exact) return exact;
  if (focus.name) {
    const needle = focus.name.toLowerCase();
    return entries.find((e) => e.role === focus.role && e.name?.toLowerCase().includes(needle));
  }
  return undefined;
}

/** The ORIGINAL (pre-A19) elision algorithm, untouched: keep the first 40% of
 * lines (landmarks/nav arrive early) plus as much of the tail as fits the
 * remaining budget (recent content, alerts). This is the exact byte-for-byte
 * behaviour every caller without a focus hint must keep seeing. */
function truncateFlat(lines: string[], maxChars: number): { text: string; truncated: boolean } {
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

/** Region-focused elision: the focus node, all of its descendants, and its
 * ancestor spine (context for where the region sits) are kept at full
 * fidelity regardless of budget. Everything else is filled in, in original
 * document order, until the remaining budget runs out — a contiguous run of
 * skipped non-focus lines collapses to one summary line, same style as
 * `truncateFlat`'s elision marker. */
function truncateFocused(
  entries: AxLineEntry[],
  focusEntry: AxLineEntry,
  maxChars: number,
): { text: string; truncated: boolean } {
  const full = entries.map((e) => e.text).join('\n');
  if (full.length <= maxChars) return { text: full, truncated: false };

  const ancestorPath = new Set(focusEntry.ancestors);
  const protectedIds = new Set<string>();
  for (const e of entries) {
    if (e.id === focusEntry.id || e.ancestors.includes(focusEntry.id) || ancestorPath.has(e.id)) {
      protectedIds.add(e.id);
    }
  }
  const protectedLen = entries
    .filter((e) => protectedIds.has(e.id))
    .reduce((sum, e) => sum + e.text.length + 1, 0);
  const budgetLeft0 = Math.max(0, maxChars - protectedLen - 64);

  const out: string[] = [];
  let truncated = false;
  let budgetLeft = budgetLeft0;
  let i = 0;
  while (i < entries.length) {
    const e = entries[i];
    if (protectedIds.has(e.id)) {
      out.push(e.text);
      i++;
      continue;
    }
    let j = i;
    const run: string[] = [];
    while (j < entries.length && !protectedIds.has(entries[j].id)) {
      run.push(entries[j].text);
      j++;
    }
    const runText = run.join('\n');
    if (runText.length + 1 <= budgetLeft) {
      out.push(runText);
      budgetLeft -= runText.length + 1;
    } else {
      truncated = true;
      out.push(`  … (${run.length} nodes truncated) …`);
    }
    i = j;
  }
  return { text: out.join('\n'), truncated };
}

/** Serialize an already-pruned `AxNode` tree to the planner's compact
 * indented text. Purely additive over the pre-A19 shape: called with no
 * `opts` (or an unmatched focus hint), this is byte-identical to the original
 * `serialize()` — same ids, same text, same truncation algorithm. A focus
 * hint only changes what gets kept when a truncation decision has to be
 * made at all. */
export function serializeAxTree(root: AxNode, opts: SerializeAxTreeOptions = {}): { text: string; truncated: boolean } {
  const maxChars = opts.maxChars ?? MAX_CHARS;
  const entries: AxLineEntry[] = [];
  const walk = (n: AxNode, depth: number, ancestors: string[]) => {
    const parts: (string | undefined)[] = [n.id, n.role];
    if (n.name) parts.push(JSON.stringify(n.name));
    if (n.value) parts.push(`value=${JSON.stringify(n.value)}`);
    if (n.states?.length) parts.push(`(${n.states.join(', ')})`);
    entries.push({
      id: n.id,
      role: n.role,
      name: n.name,
      text: '  '.repeat(depth) + parts.join(' '),
      ancestors,
    });
    if (depth >= MAX_DEPTH) return; // pathologically deep DOM — stop descending, let truncation handle the rest
    for (const c of n.children ?? []) walk(c, depth + 1, [...ancestors, n.id]);
  };
  walk(root, 0, []);

  const focusEntry = opts.focus ? findFocusEntry(entries, opts.focus) : undefined;
  if (!focusEntry) return truncateFlat(entries.map((e) => e.text), maxChars);
  return truncateFocused(entries, focusEntry, maxChars);
}

export async function snapshotAxTree(client: CDP.Client, opts: SerializeAxTreeOptions = {}): Promise<AxTreeResult> {
  const { nodes } = (await client.Accessibility.getFullAXTree({})) as { nodes: RawAxNode[] };
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => !n.parentId && !n.ignored) ?? nodes[0];
  if (!root) throw new Error('empty accessibility tree');

  // A8 (P1): ONE bulk DOM fetch per snapshot (not per node, and not an
  // additional per-step round-trip beyond the snapshot every step already
  // takes) to pick up data-testid/aliases — see AxNode.testId's doc comment
  // for why this is what lets replay resolve by testid for free. Best-effort:
  // a torn-down frame mid-navigation just means no testids are known for this
  // snapshot, same as today's testid-less behaviour.
  let testIdByBackendId = new Map<number, string>();
  try {
    const { root: domRoot } = (await client.DOM.getDocument({ depth: -1, pierce: true })) as unknown as { root: DomAttrNode };
    testIdByBackendId = buildTestIdMap(domRoot);
  } catch {
    /* no testids available for this snapshot — resolution falls back to role+name */
  }

  const nodeMap = new Map<string, number>();
  let seq = 0;

  const keep = (role: string, name: string, parentName: string, testId?: string): boolean => {
    // A8: a node carrying a test attribute is ALWAYS worth keeping, even when
    // it would otherwise collapse (no accessible name, a generic/presentation
    // role) — the canvas/SVG/charting-widget case the A8 finding calls out as
    // having no accessible name at all.
    if (testId) return true;
    if (INTERACTIVE.has(role) || STRUCTURAL.has(role)) return true;
    // page text (totals, error banners…) is evidence — but not when it merely
    // repeats the name of the element it lives in
    if (role === 'StaticText') return name.length > 0 && name !== parentName;
    return name.length > 0 && name !== parentName;
  };

  const build = (raw: RawAxNode | undefined, parentName: string, depth = 0): AxNode[] => {
    if (!raw || raw.ignored) {
      // promote children of ignored nodes
      if (depth >= MAX_DEPTH) return [];
      return (raw?.childIds ?? []).flatMap((cid) => build(byId.get(cid), parentName, depth + 1));
    }
    const role = raw.role?.value ?? '';
    if (role === 'InlineTextBox' || role === 'LineBreak') return []; // layout artifacts of StaticText
    const name = (raw.name?.value ?? '').trim();
    const testId = raw.backendDOMNodeId !== undefined ? testIdByBackendId.get(raw.backendDOMNodeId) : undefined;
    const children = depth >= MAX_DEPTH
      ? [] // pathologically deep DOM — stop descending, let MAX_CHARS truncation handle the rest
      : (raw.childIds ?? []).flatMap((cid) => build(byId.get(cid), name || parentName, depth + 1));

    if (!keep(role, name, parentName, testId)) return children; // collapse: promote children

    const states = (raw.properties ?? [])
      .filter((p) => STATE_PROPS.has(p.name) && p.value?.value !== false && p.value?.value !== 'false')
      .map((p) => (p.value?.value === true || p.value?.value === undefined ? p.name : `${p.name}=${p.value.value}`));

    const id = `n${seq++}`;
    if (raw.backendDOMNodeId !== undefined) nodeMap.set(id, raw.backendDOMNodeId);
    const node: AxNode = {
      id,
      role,
      ...(name && { name }),
      ...(raw.value?.value && { value: raw.value.value }),
      ...(states.length && { states }),
      ...(testId && { testId }),
      ...(children.length && { children }),
    };
    return [node];
  };

  const roots = build(root, '');
  const rootNode: AxNode = roots.length === 1 ? roots[0] : { id: `n${seq++}`, role: 'RootWebArea', children: roots };

  const { text, truncated } = serializeAxTree(rootNode, opts);
  return { snapshot: { root: rootNode, text, truncated }, nodeMap };
}
