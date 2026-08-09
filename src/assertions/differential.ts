/* Tier 1 differential oracle (A24) — compare a run against a baseline (or
 * against a second live environment) instead of against a human-written
 * expectation. Two independent surfaces, both pure/deterministic, no model
 * call, no browser:
 *
 *  - AxStructuralDiff (diffAxStructure) — structural diff over two
 *    AxSnapshots. This codebase is already AX-first (src/capture/axtree.ts,
 *    src/cache/action-cache.ts's pageSignatureFromAx), and the design doc
 *    (docs/plan/26-08-08-options-autonomy-layer.md, A24 Tier 1) explicitly
 *    prefers this over pixel diffing, which is noisy (fonts, animation,
 *    dynamic content) — pixel diffing is deliberately NOT implemented here.
 *  - diffNetworkShape — same request set, same status *classes* (2xx/3xx/
 *    4xx/5xx/failed), reusing the `failed`/`clientError` flags NetworkEntry
 *    already carries as of A18.
 *
 * The blessing problem (see module doc on saveBaseline/blessBaseline below)
 * is the central design tension of this tier: diffing across TIME needs a
 * human to bless intentional changes, which fights autonomy; diffing across
 * ENVIRONMENTS needs no blessing at all, because both sides are live
 * simultaneously and divergence IS the signal. Both are first-class here —
 * compareToBaseline() and compareEnvironments() — per the design doc's
 * recommendation to make the environment mode a peer, not an afterthought.
 *
 * Confidence: the audit (26-08-08-audit-deterministic-speed.md, A24) rates
 * Tier 0 + Tier 1 together as capturing "most of what an autonomous system
 * can catch without human intent" — this tier is considered solid, not
 * speculative, PROVIDED masks are configured for whatever the target app
 * renders that legitimately changes every run (timestamps, prices, ids,
 * request-id headers baked into URLs). Without masking, false positives from
 * pure data churn are expected and are the reason the collection-collapsing
 * logic below exists (see canonicalizeChildren). */

import type { AxNode, AxSnapshot, NetworkEntry } from '../ports/browser-port.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Masks — dynamic content that must not participate in comparison
// ---------------------------------------------------------------------------

/** A mask suppresses volatile content before diffing. AxSnapshot carries no
 * DOM selector information (see AxNode in browser-port.ts — role/name/value/
 * states only), so unlike a DOM/pixel differ this cannot mask by CSS
 * selector; scoping is by AX role and/or a regex/literal match against the
 * node's name/value text. That is a real, documented limitation, not an
 * oversight — the AX layer simply doesn't carry more than this. */
export interface DiffMask {
  /** Restrict this mask to nodes of this AX role (case-insensitive). Omit to apply to any node's text. */
  role?: string;
  /** Regex or literal substring matched against name/value text (and network URLs) and replaced with a stable placeholder. */
  pattern: RegExp | string;
  /** Human label shown in the placeholder, e.g. 'timestamp', 'price', 'id'. */
  label?: string;
}

function maskRegex(pattern: RegExp | string): RegExp {
  if (typeof pattern === 'string') {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  }
  const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
  return new RegExp(pattern.source, flags);
}

/** Apply the subset of `masks` scoped to `role` (or scoped to no role) to `text`. */
function applyMasks(text: string, masks: DiffMask[] | undefined, role?: string): string {
  if (!text || !masks?.length) return text;
  let out = text;
  for (const m of masks) {
    if (m.role && role !== undefined && m.role.toLowerCase() !== role.toLowerCase()) continue;
    if (m.role && role === undefined) continue;
    out = out.replace(maskRegex(m.pattern), `«${m.label ?? 'masked'}»`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// AX structural diff
// ---------------------------------------------------------------------------

export interface AxRegionChange {
  kind: 'added' | 'removed' | 'changed';
  /** Structural path from the AX root, e.g. `RootWebArea/dialog"Confirm delete"`. Repeated
   * siblings collapse to a single `role[]` segment — see canonicalizeChildren. */
  path: string;
  role: string;
  name?: string;
  detail: string;
}

export interface AxStructuralDiffResult {
  changes: AxRegionChange[];
}

interface RegionEntry {
  path: string;
  role: string;
  name?: string;
  kind: 'collection' | 'singular';
  /** Masked value/states signature used ONLY to detect "changed" at a matched path — child
   * structure is tracked as separate map entries, not folded into this. */
  selfSignature: string;
}

const REGION_WALK_BUDGET = 20_000;

/** Walk `node`'s children, grouping by role. A role with >1 sibling in this
 * snapshot is treated as a homogeneous repeated collection (a list/table's
 * rows, a grid of cards, …): its identity collapses to `role[]` with the
 * item NAME dropped (names vary per item — that is exactly the "pure data
 * churn" the design doc says must not false-positive) and only ONE
 * representative item's subtree is recursed into, under the same collapsed
 * path prefix, so 10 items and 11 items of identical shape produce identical
 * canonical entries. A role with exactly 1 sibling is treated as a normal,
 * individually-identified singular node (role+masked-name).
 *
 * This is a heuristic, not a guarantee: a group that grows from 1 to 2 items
 * crosses the singular/collection boundary and can read as "changed" rather
 * than "just more data" — an accepted, documented edge case rather than a
 * silent one. */
function canonicalizeChildren(
  node: AxNode,
  parentPath: string,
  masks: DiffMask[] | undefined,
  budget: { n: number },
  out: Map<string, RegionEntry>,
): void {
  const children = node.children ?? [];
  const byRole = new Map<string, AxNode[]>();
  for (const c of children) {
    const role = (c.role ?? '').toLowerCase() || 'unknown';
    const arr = byRole.get(role) ?? [];
    arr.push(c);
    byRole.set(role, arr);
  }

  for (const [role, group] of byRole) {
    if (budget.n <= 0) return;
    const isCollection = group.length > 1;
    if (isCollection) {
      const path = `${parentPath}/${role}[]`;
      const rep = group[0];
      const selfSignature = selfSignatureOf(rep, masks, true);
      budget.n--;
      out.set(path, { path, role, name: undefined, kind: 'collection', selfSignature });
      canonicalizeChildren(rep, path, masks, budget, out);
    } else {
      const child = group[0];
      const maskedName = applyMasks((child.name ?? '').trim(), masks, child.role);
      const path = `${parentPath}/${role}${maskedName ? `"${maskedName}"` : ''}`;
      const selfSignature = selfSignatureOf(child, masks, false);
      budget.n--;
      out.set(path, { path, role, name: maskedName || undefined, kind: 'singular', selfSignature });
      canonicalizeChildren(child, path, masks, budget, out);
    }
  }
}

function selfSignatureOf(node: AxNode, masks: DiffMask[] | undefined, dropName: boolean): string {
  const name = dropName ? '' : applyMasks((node.name ?? '').trim(), masks, node.role);
  const value = applyMasks((node.value ?? '').trim(), masks, node.role);
  const states = [...(node.states ?? [])].sort().join(',');
  return `${name}|${value}|${states}`;
}

function buildRegionMap(ax: AxSnapshot, masks: DiffMask[] | undefined): Map<string, RegionEntry> {
  const out = new Map<string, RegionEntry>();
  if (!ax?.root) return out;
  const rootPath = (ax.root.role ?? 'root').toLowerCase();
  canonicalizeChildren(ax.root, rootPath, masks, { n: REGION_WALK_BUDGET }, out);
  return out;
}

/** Compare two AxSnapshots and report added/removed/changed structural
 * regions. Deliberately region-level, not node-level: pure repetition-count
 * churn (a list going 10 -> 11 items of the same shape) is ignored by
 * construction (see canonicalizeChildren); a genuinely new region (a modal
 * that did not exist before) is reported as `added`. `masks` are applied to
 * node names/values before any comparison happens. */
export function diffAxStructure(before: AxSnapshot, after: AxSnapshot, masks?: DiffMask[]): AxStructuralDiffResult {
  const beforeMap = buildRegionMap(before, masks);
  const afterMap = buildRegionMap(after, masks);
  const changes: AxRegionChange[] = [];

  for (const [regionPath, b] of beforeMap) {
    if (!afterMap.has(regionPath)) {
      changes.push({
        kind: 'removed',
        path: regionPath,
        role: b.role,
        name: b.name,
        detail: `Region "${regionPath}" is gone in the after snapshot.`,
      });
    }
  }
  for (const [regionPath, a] of afterMap) {
    const b = beforeMap.get(regionPath);
    if (!b) {
      changes.push({
        kind: 'added',
        path: regionPath,
        role: a.role,
        name: a.name,
        detail: `Region "${regionPath}" is new in the after snapshot.`,
      });
    } else if (b.selfSignature !== a.selfSignature) {
      changes.push({
        kind: 'changed',
        path: regionPath,
        role: a.role,
        name: a.name,
        detail: `Region "${regionPath}" has the same shape but its own name/value/state changed.`,
      });
    }
  }
  return { changes };
}

// ---------------------------------------------------------------------------
// Network-shape diff
// ---------------------------------------------------------------------------

export type StatusClass = '2xx' | '3xx' | '4xx' | '5xx' | 'failed' | 'unknown';

export interface NetworkShapeEntry {
  method: string;
  /** Origin+pathname with numeric path segments and configured masks collapsed, query dropped. */
  path: string;
  statusClass: StatusClass;
}

export interface NetworkStatusClassChange {
  method: string;
  path: string;
  before: StatusClass;
  after: StatusClass;
}

export interface NetworkShapeDiffResult {
  /** Requests present after but absent before (same masked method+path key). */
  addedRequests: NetworkShapeEntry[];
  /** Requests present before but absent after — "a disappeared request". */
  removedRequests: NetworkShapeEntry[];
  /** Same request on both sides, but its status class differs (e.g. 2xx -> 5xx). */
  statusClassChanges: NetworkStatusClassChange[];
}

function statusClassOf(entry: NetworkEntry): StatusClass {
  if (typeof entry.status === 'number') {
    if (entry.status >= 500) return '5xx';
    if (entry.status >= 400) return '4xx';
    if (entry.status >= 300) return '3xx';
    if (entry.status >= 200) return '2xx';
    return 'unknown';
  }
  if (entry.failed || entry.clientError) return 'failed';
  return 'unknown';
}

/** Normalize a URL to origin+pathname with numeric segments and configured
 * masks collapsed, query string dropped entirely (query values are exactly
 * the kind of thing — pagination cursors, cache-busters, ids — that churns
 * run to run without being a shape change). */
function normalizeRequestPath(url: string, masks: DiffMask[] | undefined): string {
  let base: string;
  try {
    const u = new URL(url);
    base = `${u.origin}${u.pathname}`;
  } catch {
    base = url.split('?')[0] ?? url;
  }
  base = base.replace(/\/\d+(?=\/|$)/g, '/:id');
  base = base.replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, '/:uuid');
  if (masks?.length) base = applyMasks(base, masks);
  return base;
}

function shapeKey(entry: NetworkShapeEntry): string {
  return `${entry.method.toUpperCase()} ${entry.path}`;
}

function toShapeEntries(entries: NetworkEntry[], masks: DiffMask[] | undefined): Map<string, NetworkShapeEntry[]> {
  const out = new Map<string, NetworkShapeEntry[]>();
  for (const e of entries) {
    const shape: NetworkShapeEntry = {
      method: (e.method || 'GET').toUpperCase(),
      path: normalizeRequestPath(e.url, masks),
      statusClass: statusClassOf(e),
    };
    const key = shapeKey(shape);
    const arr = out.get(key) ?? [];
    arr.push(shape);
    out.set(key, arr);
  }
  return out;
}

/** Compare the request "shape" of two runs: same masked method+path keys
 * present on both sides, and (for keys present on both) the same status
 * class. Deliberately ignores exact counts within a matched key and exact
 * timing — those are noisy; presence/absence and status class are not. */
export function diffNetworkShape(before: NetworkEntry[], after: NetworkEntry[], masks?: DiffMask[]): NetworkShapeDiffResult {
  const beforeMap = toShapeEntries(before, masks);
  const afterMap = toShapeEntries(after, masks);

  const addedRequests: NetworkShapeEntry[] = [];
  const removedRequests: NetworkShapeEntry[] = [];
  const statusClassChanges: NetworkStatusClassChange[] = [];

  for (const [key, group] of beforeMap) {
    if (!afterMap.has(key)) removedRequests.push(group[0]);
  }
  for (const [key, group] of afterMap) {
    const beforeGroup = beforeMap.get(key);
    if (!beforeGroup) {
      addedRequests.push(group[0]);
      continue;
    }
    // Compare the "worst" status class seen on each side for this key — a
    // single 5xx among otherwise-200 retries is exactly what this tier
    // exists to catch, so don't let it average away.
    const rank: Record<StatusClass, number> = { '2xx': 0, '3xx': 1, unknown: 1, '4xx': 2, failed: 3, '5xx': 4 };
    const worst = (g: NetworkShapeEntry[]) => g.reduce((w, e) => (rank[e.statusClass] > rank[w] ? e.statusClass : w), g[0].statusClass);
    const beforeWorst = worst(beforeGroup);
    const afterWorst = worst(group);
    if (beforeWorst !== afterWorst) {
      statusClassChanges.push({ method: group[0].method, path: group[0].path, before: beforeWorst, after: afterWorst });
    }
  }

  return { addedRequests, removedRequests, statusClassChanges };
}

// ---------------------------------------------------------------------------
// Combined comparison — baseline (time) and environment (live-vs-live) modes
// ---------------------------------------------------------------------------

export interface ComparisonInput {
  ax: AxSnapshot;
  network: NetworkEntry[];
}

export interface DifferentialResult {
  mode: 'baseline' | 'environment';
  axChanges: AxRegionChange[];
  network: NetworkShapeDiffResult;
  /** True when neither surface found anything — a clean bill of health under the given masks. */
  clean: boolean;
}

function isClean(axChanges: AxRegionChange[], network: NetworkShapeDiffResult): boolean {
  return axChanges.length === 0 && network.addedRequests.length === 0 && network.removedRequests.length === 0 && network.statusClassChanges.length === 0;
}

/** Diff across TIME: this run vs a previously-blessed baseline. Subject to
 * the blessing problem — every intentional UI change reads as a regression
 * until a human re-blesses (see blessBaseline). Uses the baseline's own
 * stored masks unless the caller overrides them. */
export function compareToBaseline(current: ComparisonInput, baseline: Baseline, masks?: DiffMask[]): DifferentialResult {
  const effectiveMasks = masks ?? baseline.masks;
  const axChanges = diffAxStructure(baseline.ax, current.ax, effectiveMasks).changes;
  const network = diffNetworkShape(baseline.network, current.network, effectiveMasks);
  return { mode: 'baseline', axChanges, network, clean: isClean(axChanges, network) };
}

/** Diff across ENVIRONMENTS (staging vs prod, PR preview vs main): the
 * escape from the blessing problem, per the design doc. Both sides are live
 * simultaneously, so there is no "which one is right" question to defer to a
 * human — divergence itself IS the signal, and this needs no baseline store
 * at all. First-class alongside compareToBaseline, not a fallback. */
export function compareEnvironments(a: ComparisonInput, b: ComparisonInput, masks?: DiffMask[]): DifferentialResult {
  const axChanges = diffAxStructure(a.ax, b.ax, masks).changes;
  const network = diffNetworkShape(a.network, b.network, masks);
  return { mode: 'environment', axChanges, network, clean: isClean(axChanges, network) };
}

// ---------------------------------------------------------------------------
// Baseline store — .spike/baselines/<flow>.json
// ---------------------------------------------------------------------------

export interface Baseline {
  flow: string;
  createdAt: string;
  /** Set only by blessBaseline — an unblessed, freshly-saved baseline has no blessedAt. */
  blessedAt?: string;
  ax: AxSnapshot;
  network: NetworkEntry[];
  masks?: DiffMask[];
  meta?: Record<string, unknown>;
}

export const DEFAULT_BASELINE_DIR = '.spike/baselines';

function safeFlowName(flow: string): string {
  const cleaned = flow.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length ? cleaned.slice(0, 120) : 'flow';
}

export function baselineFilePath(flow: string, dir: string = DEFAULT_BASELINE_DIR): string {
  return path.join(dir, `${safeFlowName(flow)}.json`);
}

/** Persist a baseline as-is (no blessedAt bookkeeping — callers that want the
 * "explicit human act" semantics should go through blessBaseline instead;
 * this is the raw primitive both build on). */
export async function saveBaseline(baseline: Baseline, dir: string = DEFAULT_BASELINE_DIR): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = baselineFilePath(baseline.flow, dir);
  await writeFile(file, JSON.stringify(baseline, null, 2), 'utf8');
  return file;
}

export async function loadBaseline(flow: string, dir: string = DEFAULT_BASELINE_DIR): Promise<Baseline | null> {
  try {
    const raw = await readFile(baselineFilePath(flow, dir), 'utf8');
    return JSON.parse(raw) as Baseline;
  } catch (err) {
    if (err && typeof err === 'object' && (err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** THE escape hatch from the blessing problem for time-to-time comparisons:
 * an explicit human (or CI-triggered, e.g. "this coincided with a known
 * deploy") act that overwrites the stored baseline with `current`, stamping
 * `blessedAt`. Nothing in this module calls this automatically — a baseline
 * only ever changes when something outside the diff itself decides the new
 * shape is correct. Preserves `createdAt`/`meta`/`masks` from the prior
 * baseline when the caller doesn't override them, so re-blessing doesn't
 * lose provenance. */
export async function blessBaseline(
  flow: string,
  current: ComparisonInput,
  opts?: { masks?: DiffMask[]; dir?: string; meta?: Record<string, unknown> },
): Promise<Baseline> {
  const dir = opts?.dir ?? DEFAULT_BASELINE_DIR;
  const existing = await loadBaseline(flow, dir);
  const now = new Date().toISOString();
  const baseline: Baseline = {
    flow,
    createdAt: existing?.createdAt ?? now,
    blessedAt: now,
    ax: current.ax,
    network: current.network,
    masks: opts?.masks ?? existing?.masks,
    meta: opts?.meta ?? existing?.meta,
  };
  await saveBaseline(baseline, dir);
  return baseline;
}
