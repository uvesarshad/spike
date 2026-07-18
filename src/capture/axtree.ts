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
 * serialized-tree walk (`serialize`'s `walk`) — a pathologically deep DOM
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

export interface AxTreeResult {
  snapshot: AxSnapshot;
  nodeMap: Map<string, number>;
}

export async function snapshotAxTree(client: CDP.Client): Promise<AxTreeResult> {
  const { nodes } = (await client.Accessibility.getFullAXTree({})) as { nodes: RawAxNode[] };
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => !n.parentId && !n.ignored) ?? nodes[0];
  if (!root) throw new Error('empty accessibility tree');

  const nodeMap = new Map<string, number>();
  let seq = 0;

  const keep = (role: string, name: string, parentName: string): boolean => {
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
    const children = depth >= MAX_DEPTH
      ? [] // pathologically deep DOM — stop descending, let MAX_CHARS truncation handle the rest
      : (raw.childIds ?? []).flatMap((cid) => build(byId.get(cid), name || parentName, depth + 1));

    if (!keep(role, name, parentName)) return children; // collapse: promote children

    const states = (raw.properties ?? [])
      .filter((p) => STATE_PROPS.has(p.name) && p.value?.value !== false && p.value?.value !== 'false')
      .map((p) => (p.value?.value === true || p.value?.value === undefined ? p.name : `${p.name}=${p.value.value}`));

    const id = `n${seq++}`;
    if (raw.backendDOMNodeId !== undefined) nodeMap.set(id, raw.backendDOMNodeId);
    const node: AxNode = { id, role, ...(name && { name }), ...(raw.value?.value && { value: raw.value.value }), ...(states.length && { states }), ...(children.length && { children }) };
    return [node];
  };

  const roots = build(root, '');
  const rootNode: AxNode = roots.length === 1 ? roots[0] : { id: `n${seq++}`, role: 'RootWebArea', children: roots };

  let { text, truncated } = serialize(rootNode);
  return { snapshot: { root: rootNode, text, truncated }, nodeMap };
}

function serialize(root: AxNode): { text: string; truncated: boolean } {
  const lines: string[] = [];
  const walk = (n: AxNode, depth: number) => {
    const parts = [n.id, n.role];
    if (n.name) parts.push(JSON.stringify(n.name));
    if (n.value) parts.push(`value=${JSON.stringify(n.value)}`);
    if (n.states?.length) parts.push(`(${n.states.join(', ')})`);
    lines.push('  '.repeat(depth) + parts.join(' '));
    if (depth >= MAX_DEPTH) return; // pathologically deep DOM — stop descending, let MAX_CHARS truncation handle the rest
    for (const c of n.children ?? []) walk(c, depth + 1);
  };
  walk(root, 0);

  let text = lines.join('\n');
  let truncated = false;
  if (text.length > MAX_CHARS) {
    // keep head (landmarks/nav arrive early) + tail (recent content, alerts)
    const head = lines.slice(0, Math.floor(lines.length * 0.4));
    const keepChars = MAX_CHARS - head.join('\n').length - 64;
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
