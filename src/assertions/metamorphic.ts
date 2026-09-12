/* Tier 2 metamorphic oracle (A24) — relations that must hold ACROSS two
 * observations of a flow, regardless of what the flow's absolute correct
 * output is supposed to be: add an item -> cart count +1; remove -> -1;
 * sort -> same set, different order; filter -> subset; adjacent pagination
 * pages -> disjoint; login -> logout -> login -> same state; same URL twice
 * (no intervening mutation) -> same state.
 *
 * Everything in this file is a PURE predicate over plain data (counts, item
 * id sets, urls, small state blobs) — no browser, no model, no I/O. That is
 * what makes it cheap to run on every relevant step forever once a relation
 * has been judged applicable.
 *
 * Confidence, stated plainly (the audit explicitly flags this whole tier as
 * research-flavoured, not a scheduled certainty — 26-08-08-audit-
 * deterministic-speed.md A24, 26-08-08-options-autonomy-layer.md A24 Tier 2):
 *   - RELIABLE as pure math, low false-positive risk: addItemIncrementsCount,
 *     removeItemDecrementsCount, sortPreservesSet, filterIsSubset,
 *     paginationPagesDisjoint, checkPaginationUnion. Each checks an exact,
 *     unambiguous set/count property; if the inputs are captured correctly
 *     there is nothing fuzzy about the verdict.
 *   - SPECULATIVE: loginLogoutLoginReturnsToSameState and
 *     sameUrlTwiceSameState. "Same state" is only as good as the caller's
 *     Observation.state blob, and legitimate per-visit noise (a "welcome
 *     back" banner, a live viewer count, a rotating promo) will produce
 *     false-positive violations unless the caller pre-masks those fields
 *     before calling checkRelation. Treat a violation from either of these
 *     two as "worth a look", not "definitely a regression".
 *
 * The harder, genuinely unsolved part of this tier is not the predicates
 * above — it's knowing WHICH relation plausibly applies to a given page.
 * detectRelationCandidates() below implements the deterministic half of
 * that (regex/role sniffing over an AxSnapshot for cart badges, sortable
 * columns, filters, paginators) with NO model call. The design doc's
 * recommendation is "AI proposes candidate relations once per detected
 * pattern, then they run deterministically forever" — the AI-authoring half
 * is a deliberate, documented seam, not implemented here:
 *
 *   SEAM: a future proposeRelationsWithModel(ax, screenshot?) would ask a
 *   model to look at pages detectRelationCandidates() found NOTHING for (or
 *   to corroborate/extend what it did find), returning additional
 *   RelationProposal-shaped candidates. Those candidates get verified once
 *   (a human or a one-off check confirms the proposed relation actually
 *   holds on this app) and from then on run through checkRelation() exactly
 *   like the heuristic-detected ones — the model is never consulted again
 *   for that pattern. This module intentionally contains no such call; the
 *   caller (driver/loop.ts or a suite runner, owned elsewhere in this sweep)
 *   is where that would be wired in, merging model proposals with
 *   detectRelationCandidates()'s output before either is run. */

import type { AxNode, AxSnapshot } from '../ports/browser-port.js';

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/** A snapshot of whatever a relation needs to reason about, taken before and
 * after the action under test (e.g. "add to cart", "click Sort by price").
 * Deliberately generic/untyped-per-domain — callers project whatever they
 * captured (AX text, extracted values, URL) into this shape. */
export interface Observation {
  /** Named counters, e.g. { cart: 3 }. */
  counts?: Record<string, number>;
  /** Item identifiers visible in the current view (product ids/names, row keys, …), for set-membership relations. */
  items?: string[];
  /** Current URL. */
  url?: string;
  /** Free-form state signature for "returns to the same state" relations — e.g. serialized cart contents, auth status, form values. Compared key-by-key with JSON equality. */
  state?: Record<string, unknown>;
}

export interface RelationViolation {
  relation: string;
  detail: string;
  evidence?: Record<string, unknown>;
  /** A1 (P0): true when this "violation" is actually a missing-data report
   * (the Observation didn't carry the field the relation needed) rather than
   * a genuine contradiction — e.g. makeCountDeltaRelation's before/after
   * counter absent. Callers that GATE a verdict on relation violations
   * (driver/loop.ts's strictOracles) must treat these as "no evidence
   * either way", never as a fail — only a set `insufficientData` on a
   * REAL mismatch would be a false positive gate. */
  insufficientData?: boolean;
}

export interface RelationParams {
  /** Which Observation.counts key this relation reasons about (default 'count'). */
  countKey?: string;
  /** Expected delta for count-delta relations (default relation-specific). */
  delta?: number;
  /** Observation.state keys to ignore when comparing (per-visit noise the caller knows about but hasn't stripped upstream). */
  stateKeysToIgnore?: string[];
}

export interface Relation {
  id: string;
  label: string;
  confidence: 'reliable' | 'speculative';
  check(before: Observation, after: Observation, params?: RelationParams): RelationViolation | null;
}

/** Thin wrapper so callers don't need to know relations are just objects with a `check` method. */
export function checkRelation(relation: Relation, before: Observation, after: Observation, params?: RelationParams): RelationViolation | null {
  return relation.check(before, after, params);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function asSet(items: string[] | undefined): Set<string> {
  return new Set(items ?? []);
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function isSubset(sub: Set<string>, sup: Set<string>): boolean {
  for (const x of sub) if (!sup.has(x)) return false;
  return true;
}

function stateEqual(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined, ignore: string[] = []): boolean {
  const keysOf = (r: Record<string, unknown> | undefined) =>
    Object.keys(r ?? {})
      .filter((k) => !ignore.includes(k))
      .sort();
  const ak = keysOf(a);
  const bk = keysOf(b);
  if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
  for (const k of ak) {
    if (JSON.stringify((a as Record<string, unknown>)[k]) !== JSON.stringify((b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Relation library
// ---------------------------------------------------------------------------

function makeCountDeltaRelation(id: string, label: string, defaultDelta: number, defaultKey = 'cart'): Relation {
  return {
    id,
    label,
    confidence: 'reliable',
    check(before, after, params) {
      const key = params?.countKey ?? defaultKey;
      const delta = params?.delta ?? defaultDelta;
      const b = before.counts?.[key];
      const a = after.counts?.[key];
      if (typeof b !== 'number' || typeof a !== 'number') {
        return {
          relation: id,
          detail: `Observation is missing the "${key}" count needed to check this relation.`,
          evidence: { beforeCount: b, afterCount: a },
          insufficientData: true,
        };
      }
      const expected = b + delta;
      if (a !== expected) {
        return {
          relation: id,
          detail: `Expected "${key}" to go from ${b} to ${expected} (delta ${delta}), but it went to ${a}.`,
          evidence: { before: b, after: a, expectedDelta: delta },
        };
      }
      return null;
    },
  };
}

/** Add item -> cart count +1 (or whatever counter/delta params override). */
export const addItemIncrementsCount: Relation = makeCountDeltaRelation('add-item-increments-count', 'Adding an item increases the counter by exactly the expected delta (default +1, e.g. a cart badge).', 1);

/** Remove item -> cart count -1. */
export const removeItemDecrementsCount: Relation = makeCountDeltaRelation('remove-item-decrements-count', 'Removing an item decreases the counter by exactly the expected delta (default -1, e.g. a cart badge).', -1);

/** Sort -> same item set, different order. Order is not checked (a sort that
 * happens to not change the visible order is not a violation) — only that no
 * item was gained or lost. */
export const sortPreservesSet: Relation = {
  id: 'sort-preserves-set',
  label: 'Sorting changes order but never membership: after has exactly the same item set as before.',
  confidence: 'reliable',
  check(before, after) {
    const b = asSet(before.items);
    const a = asSet(after.items);
    if (!setsEqual(a, b)) {
      const missing = [...b].filter((x) => !a.has(x));
      const extra = [...a].filter((x) => !b.has(x));
      return {
        relation: 'sort-preserves-set',
        detail: `Sorting changed the item set (expected the same ${b.size} item(s), just reordered).`,
        evidence: { missing, extra },
      };
    }
    return null;
  },
};

/** Filter -> the result set is a subset of the unfiltered/broader set. */
export const filterIsSubset: Relation = {
  id: 'filter-is-subset',
  label: 'Filtering only narrows the result set: after items ⊆ before items.',
  confidence: 'reliable',
  check(before, after) {
    const b = asSet(before.items);
    const a = asSet(after.items);
    if (!isSubset(a, b)) {
      const foreign = [...a].filter((x) => !b.has(x));
      return {
        relation: 'filter-is-subset',
        detail: 'Filtering produced item(s) that were not present in the unfiltered set.',
        evidence: { foreign },
      };
    }
    return null;
  },
};

/** Adjacent pagination pages contain disjoint items — call once per adjacent
 * (page N, page N+1) pair. For the separate "union of all pages equals the
 * whole" property (inherently n-ary, not a before/after pair), see
 * checkPaginationUnion below — it deliberately doesn't fit the two-
 * observation Relation shape and isn't forced into it. */
export const paginationPagesDisjoint: Relation = {
  id: 'pagination-pages-disjoint',
  label: 'Adjacent pagination pages never share an item.',
  confidence: 'reliable',
  check(before, after) {
    const b = asSet(before.items);
    const a = asSet(after.items);
    const overlap = [...b].filter((x) => a.has(x));
    if (overlap.length > 0) {
      return {
        relation: 'pagination-pages-disjoint',
        detail: `Adjacent pages share ${overlap.length} item(s); pagination should partition, not repeat.`,
        evidence: { overlap },
      };
    }
    return null;
  },
};

/** Pure n-ary helper (not a Relation — there is no single before/after pair
 * for "union of every page"): the union of all given pages' items must equal
 * the expected full set. */
export function checkPaginationUnion(pages: string[][], expectedTotal: string[]): RelationViolation | null {
  const union = new Set<string>();
  for (const page of pages) for (const item of page) union.add(item);
  const total = asSet(expectedTotal);
  if (!setsEqual(union, total)) {
    const missing = [...total].filter((x) => !union.has(x));
    const extra = [...union].filter((x) => !total.has(x));
    return {
      relation: 'pagination-union-is-whole',
      detail: 'The union of all pages does not equal the expected full item set.',
      evidence: { missing, extra },
    };
  }
  return null;
}

/** Login -> logout -> login returns to the same observable state. Only the
 * two "logged in" observations (right after each login) are compared; the
 * logout in between is the caller's job to perform, not this predicate's to
 * see. SPECULATIVE — see module doc: "same state" is exactly as precise as
 * the caller's `state` blob, and real apps often legitimately vary
 * per-session (a "Welcome back" toast, a refreshed CSRF token in a hidden
 * field) — callers should mask those via `stateKeysToIgnore` or keep `state`
 * limited to fields that are genuinely supposed to be session-invariant. */
export const loginLogoutLoginReturnsToSameState: Relation = {
  id: 'login-logout-login-same-state',
  label: 'Logging out and back in returns the user to the same observable state.',
  confidence: 'speculative',
  check(before, after, params) {
    if (!stateEqual(before.state, after.state, params?.stateKeysToIgnore)) {
      return {
        relation: 'login-logout-login-same-state',
        detail: 'Observable state after the second login differs from state before logout.',
        evidence: { before: before.state ?? {}, after: after.state ?? {} },
      };
    }
    return null;
  },
};

/** Visiting the same URL twice, with no intervening mutation, yields the
 * same observable state. SPECULATIVE for the same reason as the relation
 * above, compounded by the fact that plenty of legitimately-correct pages
 * are intentionally non-idempotent in appearance (ads, "recently viewed",
 * a live clock/counter) — a violation here is a prompt to look, not an
 * automatic fail. */
export const sameUrlTwiceSameState: Relation = {
  id: 'same-url-twice-same-state',
  label: 'The same URL, visited twice with no mutation in between, renders the same observable state.',
  confidence: 'speculative',
  check(before, after, params) {
    if (before.url !== undefined && after.url !== undefined && before.url !== after.url) {
      return {
        relation: 'same-url-twice-same-state',
        detail: `URLs differ (${before.url} vs ${after.url}) — this relation only applies to two visits of the SAME url.`,
        evidence: { beforeUrl: before.url, afterUrl: after.url },
      };
    }
    const itemsEqual =
      before.items === undefined && after.items === undefined ? true : setsEqual(asSet(before.items), asSet(after.items));
    const statesEqual = stateEqual(before.state, after.state, params?.stateKeysToIgnore);
    if (!itemsEqual || !statesEqual) {
      return {
        relation: 'same-url-twice-same-state',
        detail: 'The same URL rendered different content across two visits.',
        evidence: {
          before: { items: before.items ?? [], state: before.state ?? {} },
          after: { items: after.items ?? [], state: after.state ?? {} },
        },
      };
    }
    return null;
  },
};

/** Every relation in the library, for callers that want to iterate all of
 * them (e.g. a suite runner reporting relation coverage). */
export const RELATIONS: readonly Relation[] = [
  addItemIncrementsCount,
  removeItemDecrementsCount,
  sortPreservesSet,
  filterIsSubset,
  paginationPagesDisjoint,
  loginLogoutLoginReturnsToSameState,
  sameUrlTwiceSameState,
];

// ---------------------------------------------------------------------------
// Pattern-detection seam — deterministic heuristics only, no model call
// ---------------------------------------------------------------------------

export interface RelationProposal {
  relation: Relation;
  reason: string;
  params?: RelationParams;
  /** A2 (P0): for a relation proposed BECAUSE a specific action happened (the
   * count-delta pair), the two observations bracketing THAT action. Callers
   * must check the relation against these rather than against run-start /
   * run-end — a cart badge is only supposed to move around the add/remove
   * click, not across the whole run. Absent for the page-shape relations
   * (sort/filter/pagination), which carry no single anchoring action. */
  before?: Observation;
  after?: Observation;
}

/** A2 (P0): the slice of a recorded step this module needs to decide whether
 * an add/remove action actually happened, and what the counter did around it.
 * Structurally a subset of report/report.ts's StepRecord (which is what
 * driver/loop.ts passes) — declared here so this module stays a pure
 * predicate library with no dependency on the report shape. */
export interface RelationHistoryStep {
  /** Whether the action landed. A refused or failed click did not happen. */
  ok: boolean;
  action: { type: string };
  target?: { role: string; name?: string };
  description?: string;
  /** Counters read from the page immediately BEFORE this action. */
  countsBefore?: Record<string, number>;
  /** Counters read from the page immediately AFTER this action. */
  countsAfter?: Record<string, number>;
}

function collectAxNodes(ax: AxSnapshot): AxNode[] {
  const out: AxNode[] = [];
  const budget = { n: 20_000 };
  function walk(node: AxNode): void {
    if (budget.n <= 0) return;
    budget.n--;
    out.push(node);
    for (const child of node.children ?? []) walk(child);
  }
  if (ax?.root) walk(ax.root);
  return out;
}

function nodeText(n: AxNode): string {
  return `${n.role ?? ''} ${n.name ?? ''} ${n.value ?? ''}`.trim();
}

const CART_RE = /\bcart\b/i;
const DIGIT_RE = /\d/;
/** A2 (P0): control names that ADD one item to the counter. A cart badge on
 * its own says nothing about which direction the counter is supposed to move
 * — only an action does, so these gate the +1 relation. Deliberately narrow:
 * a missed proposal costs one unchecked relation, a wrong one force-fails a
 * healthy site. */
const ADD_ITEM_RES: readonly RegExp[] = [
  /\badd\b[^]{0,32}?\b(cart|bag|basket)\b/i,
  /\badd (an? )?item\b/i,
  /\badd to (cart|bag|basket)\b/i,
];
/** Control names that REMOVE one item from the counter — the -1 half. Note
 * "empty/clear the cart" is deliberately absent: it is not a -1 action. */
const REMOVE_ITEM_RES: readonly RegExp[] = [
  /\bremove\b[^]{0,32}?\b(cart|bag|basket|item)\b/i,
  /\bremove (an? )?item\b/i,
  /\bdelete (an? )?item\b/i,
];
const SORT_RE = /\bsort\b/i;
const SORT_STATE_RE = /sort/i;
const FILTER_RE = /\bfilter\b/i;
const PAGINATION_NEXT_RE = /^(next|older|more results?)\b/i;
const PAGINATION_LABEL_RE = /\bpagination\b|\bpage \d+\s+of\s+\d+\b/i;
const FILTER_ROLES = new Set(['checkbox', 'combobox', 'button', 'radio', 'menuitemcheckbox']);

/** The text a step is matched against: the name of the control it touched,
 * falling back to the step's own description when the control had no name. */
function historyStepText(s: RelationHistoryStep): string {
  return (s.target?.name ?? '').trim() || (s.description ?? '').trim();
}

/** A2 (P0): does this step look like the add- or remove-an-item click a
 * count-delta relation talks about? Exported so the driver knows which steps
 * are worth reading the counter around — capturing it on every step would
 * cost a page snapshot per action for nothing.
 *
 * Only a LANDED click counts: a failed click, or one a look-only run refused,
 * did not move anything, so no relation about its effect applies. */
export function countDeltaDirection(step: RelationHistoryStep): 'add' | 'remove' | null {
  if (!step.ok || step.action?.type !== 'click') return null;
  const text = historyStepText(step);
  if (!text) return null;
  if (ADD_ITEM_RES.some((re) => re.test(text))) return 'add';
  if (REMOVE_ITEM_RES.some((re) => re.test(text))) return 'remove';
  return null;
}

/** At most this many count-delta proposals per direction per run — a long
 * shopping flow can add a dozen items, and each extra pair is one more chance
 * for a snapshot-timing artefact to gate a verdict for no extra signal. */
const MAX_COUNT_DELTA_PROPOSALS = 3;

/** One proposal per landed add/remove click that carries a before/after
 * counter reading. Steps without both readings are skipped outright rather
 * than proposed with no data: a relation that can only report "I couldn't
 * observe this" is noise in the report, not evidence. */
function countDeltaProposals(
  history: readonly RelationHistoryStep[],
  patterns: readonly RegExp[],
  relation: Relation,
  phrasing: string,
): RelationProposal[] {
  const out: RelationProposal[] = [];
  for (const step of history) {
    if (out.length >= MAX_COUNT_DELTA_PROPOSALS) break;
    if (!step.ok || step.action?.type !== 'click') continue;
    const text = historyStepText(step);
    if (!text || !patterns.some((re) => re.test(text))) continue;
    const before = step.countsBefore;
    const after = step.countsAfter;
    if (typeof before?.cart !== 'number' || typeof after?.cart !== 'number') continue;
    out.push({
      relation,
      reason: `The run clicked "${text}", which ${phrasing} the cart, while a cart badge was on the page.`,
      params: { countKey: 'cart' },
      before: { counts: before },
      after: { counts: after },
    });
  }
  return out;
}

/** Deterministic pattern detection over an AxSnapshot — role/name/state
 * sniffing, zero model calls, runs in a few milliseconds. This is
 * necessarily heuristic: it proposes candidates worth VERIFYING (per the
 * design doc's "AI proposes once, then runs deterministically forever"
 * model — the verification step, human or AI, happens outside this
 * function). A miss here just means no candidate was proposed for that
 * pattern on that page, not that the page is relation-free. */
export function detectRelationCandidates(ax: AxSnapshot, history: readonly RelationHistoryStep[] = []): RelationProposal[] {
  const proposals: RelationProposal[] = [];
  const nodes = collectAxNodes(ax);
  if (nodes.length === 0) return proposals;

  // --- cart badge: a node whose text mentions "cart" and carries a digit ---
  //
  // A2 (P0): the badge alone is NOT enough to propose anything. Proposing both
  // "+1 on add" and "-1 on remove" from one badge guarantees that at least one
  // of them violates on every run (they are mutually exclusive), and both did
  // when the badge never moved — which force-failed every storefront under
  // strictOracles. A count-delta relation is now proposed only for an action
  // the run ACTUALLY performed, and is checked against the counter as it stood
  // immediately before and after THAT action.
  const cartNode = nodes.find((n) => CART_RE.test(nodeText(n)) && DIGIT_RE.test(nodeText(n)));
  if (cartNode) {
    proposals.push(...countDeltaProposals(history, ADD_ITEM_RES, addItemIncrementsCount, 'adds an item to'));
    proposals.push(...countDeltaProposals(history, REMOVE_ITEM_RES, removeItemDecrementsCount, 'removes an item from'));
  }

  // --- sortable table/list: a columnheader/button naming or state-flagging sort ---
  const sortNode = nodes.find((n) => {
    if (n.role !== 'columnheader' && n.role !== 'button') return false;
    return SORT_RE.test(n.name ?? '') || (n.states ?? []).some((s) => SORT_STATE_RE.test(s));
  });
  if (sortNode) {
    proposals.push({
      relation: sortPreservesSet,
      reason: `Found a sortable control: ${sortNode.role} "${sortNode.name ?? ''}".`,
    });
  }

  // --- filter control ---
  const filterNode = nodes.find((n) => FILTER_ROLES.has(n.role) && FILTER_RE.test(n.name ?? ''));
  if (filterNode) {
    proposals.push({
      relation: filterIsSubset,
      reason: `Found a filter control: ${filterNode.role} "${filterNode.name ?? ''}".`,
    });
  }

  // --- paginator ---
  const pagerNode = nodes.find((n) => PAGINATION_NEXT_RE.test((n.name ?? '').trim()) || PAGINATION_LABEL_RE.test(nodeText(n)));
  if (pagerNode) {
    proposals.push({
      relation: paginationPagesDisjoint,
      reason: `Found a paginator control: ${pagerNode.role} "${pagerNode.name ?? ''}".`,
    });
  }

  return proposals;
}

// ---------------------------------------------------------------------------
// A1 (P0): observation extraction — the wiring checkRelation() actually needs
// ---------------------------------------------------------------------------

/** Best-effort Observation extraction from an AxSnapshot, for driver/loop.ts's
 * post-run metamorphic gate. Only the cart-badge count is generically
 * extractable without app-specific knowledge — the SAME cart-node heuristic
 * detectRelationCandidates() uses to PROPOSE the relation in the first place,
 * reused here to actually observe it. `items`/`state` are deliberately left
 * undefined: a relation that needs them (sortPreservesSet, filterIsSubset,
 * paginationPagesDisjoint, loginLogoutLoginReturnsToSameState,
 * sameUrlTwiceSameState) then compares two empty/undefined sides, which
 * every one of those predicates' set/state-equality checks treats as equal —
 * "no evidence either way" from a signal this function couldn't actually
 * observe, never a false trigger. */
export function axToObservation(ax: AxSnapshot, url?: string): Observation {
  const nodes = collectAxNodes(ax);
  const cartNode = nodes.find((n) => CART_RE.test(nodeText(n)) && DIGIT_RE.test(nodeText(n)));
  const counts: Record<string, number> = {};
  if (cartNode) {
    const m = nodeText(cartNode).match(/\d+/);
    if (m) counts.cart = Number(m[0]);
  }
  return {
    ...(Object.keys(counts).length && { counts }),
    ...(url !== undefined && { url }),
  };
}
