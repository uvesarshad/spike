/* State identity — A23 (P0).
 *
 * A "state" for coverage purposes is `(normalizedUrl, structuralSignature)`.
 * `normalizedUrl` is reused as-is from `src/cache/action-cache.ts`
 * (`normalizeUrlForActionCache`, tested, owned by nobody this wave — imported,
 * never edited). `structuralSignature` is new: the options doc
 * (`docs/plan/26-08-08-options-autonomy-layer.md`, A23) calls for "a
 * structural variant of `stableAxMaterial()` that drops `name`/`value` and
 * keeps role+depth", so `/products` with 10 vs 11 items is ONE state while
 * `/products` with a modal open is a different one.
 *
 * A naive line-per-node port of `stableAxMaterial` (drop name/value, hash the
 * remaining role+depth text) does NOT achieve that: ten `listitem` lines vs
 * eleven still differ by one line, so the hash still differs — the audit's
 * own worked example would fail. The fix used here: collect the SET (not a
 * multiset) of `depth|role` pairs across the whole tree, sort, hash. Any
 * number of same-role siblings at the same depth collapse to one entry
 * (`10 vs 11 products` -> identical set), while a genuinely new subtree (a
 * `dialog` role appearing, content pushed to a new depth) introduces a pair
 * that was not present before -> a different set -> a different signature.
 *
 * Deliberately decoupled from `src/ports/browser-port.ts`'s `AxNode`/
 * `AxSnapshot` types: this module takes a minimal structural shape
 * (`{ role, children? }`) that any real `AxNode` already satisfies (excess
 * properties like `name`/`value`/`states`/`id` are simply ignored by
 * TypeScript's structural typing), so this file has zero import-time
 * dependency on the port layer while staying drop-in compatible with a real
 * AX snapshot from the live driver loop in a future integration. HTML-derived
 * "pages" (this module's crawler has no browser, only fetched markup) build
 * the same `depth|role` pairs directly from tag nesting — see `html.ts`'s
 * `collectHtmlDepthRolePairs` — and hash them with the same
 * `signatureFromPairs` so both code paths produce comparable signatures. */

import crypto from 'node:crypto';

export interface StructuralNode {
  role: string;
  children?: StructuralNode[];
}

export interface StructuralSnapshot {
  root: StructuralNode;
}

/** Depth/role pairs collected from a structural tree, root at depth 0. */
export function collectDepthRolePairs(node: StructuralNode, depth = 0): Array<[number, string]> {
  const out: Array<[number, string]> = [[depth, node.role]];
  for (const child of node.children ?? []) out.push(...collectDepthRolePairs(child, depth + 1));
  return out;
}

/** Sorted, deduplicated `depth|role` material — the thing that actually gets
 * hashed. Exported so callers/tests can inspect the collapsed material
 * directly rather than only the opaque hash. */
export function structuralMaterialFromPairs(pairs: Array<[number, string]>): string {
  const set = new Set(pairs.map(([depth, role]) => `${depth}|${role.toLowerCase()}`));
  return [...set].sort().join('\n');
}

export function signatureFromPairs(pairs: Array<[number, string]>): string {
  return sha256(structuralMaterialFromPairs(pairs));
}

/** Structural signature of a tree, a pre-built snapshot wrapper, or raw
 * pre-computed material text (mirrors `pageSignatureFromAx`'s `AxSnapshot |
 * string` union in `action-cache.ts` so the two functions read as siblings).
 * A bare string input is hashed as opaque material directly — used when a
 * caller (e.g. `html.ts`) has already reduced a page to `depth|role` pairs
 * via a non-tree code path and just wants the final hash step shared. */
export function structuralSignatureFromAx(input: StructuralSnapshot | StructuralNode | string): string {
  if (typeof input === 'string') return sha256(input);
  const root = 'root' in input ? input.root : input;
  return signatureFromPairs(collectDepthRolePairs(root));
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}
