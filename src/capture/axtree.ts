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

/** A23 (P1): a child frame whose own accessibility tree should be spliced into
 * this snapshot. `frameId` is what CDP calls the frame (for a frame running in
 * its own process, the same value as its target id); `url` only supplies the
 * host shown in the `[frame: …]` marker. */
export interface AxChildFrame {
  frameId: string;
  url: string;
}

export interface SerializeAxTreeOptions {
  /** Caller-supplied character budget. Defaults to `MAX_CHARS` (6000). */
  maxChars?: number;
  focus?: AxFocusHint;
  /** A23 (P1): child frames to splice in — see AxChildFrame. Used only by
   * snapshotAxTree(); serializeAxTree() ignores it (by then the frames are
   * already part of the tree it is handed). Empty/absent → a snapshot
   * byte-identical to before. */
  frames?: AxChildFrame[];
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

/** Shared numbering + backend-id bookkeeping for one snapshot. A snapshot may
 * be assembled from several frames (A23), and the ids the models reference must
 * stay unique across all of them — so the counter and the map live out here,
 * one set per snapshot, never one per frame. */
interface SnapshotState {
  nodeMap: Map<string, number>;
  seq: { next: number };
}

/** Prune one frame's raw accessibility nodes into the compact tree shape.
 * Extracted from snapshotAxTree so a child frame goes through the exact same
 * keep/collapse rules as the main page rather than a second, drifting copy. */
function pruneFrame(
  nodes: RawAxNode[],
  testIdByBackendId: Map<number, string>,
  state: SnapshotState,
  /** A23: backend ids of iframe elements a child frame will be spliced under.
   * Those elements are usually name-less and would otherwise collapse away,
   * taking the splice point with them. */
  alwaysKeep: Set<number> = new Set(),
): AxNode | null {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => !n.parentId && !n.ignored) ?? nodes[0];
  if (!root) return null;

  const keep = (role: string, name: string, parentName: string, testId?: string, backendId?: number): boolean => {
    if (backendId !== undefined && alwaysKeep.has(backendId)) return true;
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

    if (!keep(role, name, parentName, testId, raw.backendDOMNodeId)) return children; // collapse: promote children

    const states = (raw.properties ?? [])
      .filter((p) => STATE_PROPS.has(p.name) && p.value?.value !== false && p.value?.value !== 'false')
      .map((p) => (p.value?.value === true || p.value?.value === undefined ? p.name : `${p.name}=${p.value.value}`));

    const id = `n${state.seq.next++}`;
    if (raw.backendDOMNodeId !== undefined) state.nodeMap.set(id, raw.backendDOMNodeId);
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
  if (!roots.length) return null;
  if (roots.length === 1) return roots[0];
  return { id: `n${state.seq.next++}`, role: 'RootWebArea', children: roots };
}

/** Host shown in a `[frame: …]` marker. A frame whose URL is opaque (about:blank,
 * a blob/data URL, or missing) is labelled by that instead of by nothing, so the
 * marker never reads as an empty pair of brackets. */
function frameLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host || parsed.protocol.replace(':', '');
  } catch {
    return url ? url.slice(0, 40) : 'unknown';
  }
}

/** Find the already-pruned node that came from a given DOM element. */
function findByBackendId(root: AxNode, backendId: number, nodeMap: Map<string, number>): AxNode | null {
  let wantedId: string | null = null;
  for (const [id, backend] of nodeMap) {
    if (backend === backendId) {
      wantedId = id;
      break;
    }
  }
  if (!wantedId) return null;
  const walk = (node: AxNode): AxNode | null => {
    if (node.id === wantedId) return node;
    for (const child of node.children ?? []) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root);
}

export async function snapshotAxTree(client: CDP.Client, opts: SerializeAxTreeOptions = {}): Promise<AxTreeResult> {
  const { nodes } = (await client.Accessibility.getFullAXTree({})) as { nodes: RawAxNode[] };

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

  const state: SnapshotState = { nodeMap: new Map(), seq: { next: 0 } };

  // A23 (P1): which <iframe> element each child frame hangs off. Payment forms,
  // sign-in widgets, chat bubbles and CAPTCHA all live in a frame of their own;
  // without this the page just stops at the frame's border and the whole flow
  // behind it is invisible. Best-effort per frame: one that has gone away by
  // the time we ask is simply skipped.
  const owners: { backendId: number; frame: AxChildFrame }[] = [];
  for (const frame of opts.frames ?? []) {
    try {
      const { backendNodeId } = (await client.DOM.getFrameOwner({ frameId: frame.frameId })) as { backendNodeId?: number };
      if (typeof backendNodeId === 'number') owners.push({ backendId: backendNodeId, frame });
    } catch {
      /* frame gone, or this connection can't see it — skip it */
    }
  }

  const rootNode = pruneFrame(nodes, testIdByBackendId, state, new Set(owners.map((o) => o.backendId)));
  if (!rootNode) throw new Error('empty accessibility tree');

  for (const { backendId, frame } of owners) {
    let childNodes: RawAxNode[];
    try {
      ({ nodes: childNodes } = (await client.Accessibility.getFullAXTree({ frameId: frame.frameId })) as { nodes: RawAxNode[] });
    } catch {
      continue; // the frame runs somewhere this connection can't reach — leave the page as it was
    }
    const childRoot = pruneFrame(childNodes, new Map(), state);
    if (!childRoot) continue;
    const marker: AxNode = {
      id: `n${state.seq.next++}`,
      role: 'frame',
      name: `[frame: ${frameLabel(frame.url)}]`,
      children: [childRoot],
    };
    const host = findByBackendId(rootNode, backendId, state.nodeMap);
    if (host) host.children = [...(host.children ?? []), marker];
    else rootNode.children = [...(rootNode.children ?? []), marker]; // the <iframe> itself collapsed away — keep the content
  }

  const { text, truncated } = serializeAxTree(rootNode, opts);
  return { snapshot: { root: rootNode, text, truncated }, nodeMap: state.nodeMap };
}
