/* A29 — close the coverage loop.
 *
 * `spike map` wrote the ledger and nothing ever updated it, so
 * `markRouteExercised`/`markElementTouched` had zero callers and
 * `spike coverage` reported 0 exercised forever. That is worse than reporting
 * nothing: A23's whole point is answering "what haven't we tested?", and an
 * always-zero answer looks like a real one.
 *
 * This is the write-back half: given a finished run's steps, mark the routes
 * they visited and the elements they actually touched.
 *
 * Deliberately best-effort and non-fatal. A missing ledger (nobody ran
 * `spike map`) is the COMMON case, not an error — coverage is opt-in, and a QA
 * run must never fail because a bookkeeping file is absent.
 *
 * A33: a route the run reached that the map never found used to be counted and
 * then thrown away, which made the tested surface SMALLER than what had
 * demonstrably been tested — and hid precisely the pages the crawl cannot see
 * (anything behind a click, a wizard step, a modal route). Those now go into
 * the ledger tagged `source: 'run'`, so "discovered by the map" and "reached
 * by a run" stay tellable apart while neither is silently dropped. They are
 * still reported in `unknownRoutes` too: the gap between the two is the signal
 * that the map is missing part of the app (see discover.ts).
 */

import { normalizeUrlForActionCache } from '../cache/action-cache.js';
import type { StepRecord } from '../report/report.js';
import { loadAppModel, markElementTouched, markRouteExercised, saveAppModel, upsertRunRoute, type AppModel, type AppModelElement, type AppModelRoute, type AppModelState } from './app-model.js';

export interface CoverageWriteResult {
  /** False when there is no ledger yet — the normal state before `spike map`. */
  ledgerPresent: boolean;
  routesMarked: string[];
  elementsMarked: number;
  /** Routes the run visited that no discovery pass had ever found. A33: these
   * are now ADDED to the ledger (tagged `source: 'run'`) as well as reported
   * here — a run reaching surface the crawler could not is exactly the signal
   * that the AI-exploration seam is needed (see discover.ts), and dropping
   * them made coverage report less than had actually been tested. They appear
   * in `routesMarked` too, since the run exercised them. */
  unknownRoutes: string[];
}

/** Element names come from two DIFFERENT sources and do not agree exactly.
 * Discovery is HTML-based (the crawler has no browser, so it reads attributes),
 * while a run is accessibility-tree-based (names come from `<label>`, aria-*,
 * and content). On the dogfood fixture the crawler recorded `email`/`password`
 * from the inputs' `id`, whereas the AX tree calls them `Email`/`Password` from
 * their labels — so exact matching touched only 1 of 3 elements and coverage
 * silently under-reported.
 *
 * Case/whitespace-insensitive comparison closes that particular gap, and helps
 * generally since the two sources differ most often in casing. It does NOT fix
 * the underlying impedance mismatch — an input labelled "Email address" with
 * `id="user_email"` still will not match.
 *
 * A33 fixes that mismatch at its source for a browser-driven map: the crawl
 * now reads control names off the SAME accessibility tree a run does (see
 * browser-crawl.ts's `interactiveElementsFromAx`), so both sides say "Email
 * address". This comparison stays as the safety net for a ledger written by a
 * plain HTTP map, which has no browser and therefore no tree to read. */
function sameName(a: string | undefined, b: string | undefined): boolean {
  return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
}

/** A51 (P2): one same-role+name candidate for element-touch attribution,
 * mirroring recorder/replay.ts's RoleMatch — `index` is the 0-based position
 * among matches, in the same DISCOVERY order (state-then-element, which
 * mirrors document order — see mergeElements in app-model.ts) that a
 * recorded `nth` (StepTarget.nth, set by the driver the same way replay's
 * `nth` locator hint is) refers to. */
interface ElementCandidate {
  state: AppModelState;
  element: AppModelElement;
  index: number;
}

/** All (state, element) pairs across a route's ENTIRE state history whose
 * role+name (case-insensitive) matches — not just the FIRST state that
 * happens to contain one. Before this, `applyRunToModel` walked
 * `route.states` and stopped at the first state with a matching element,
 * silently mis-attributing a touch to the WRONG structural state whenever
 * more than one state shares that role+name — the common case for anything
 * present both logged-in and logged-out, or before/after a redesign the
 * ledger kept history for (see app-model.ts's file header on why states
 * accumulate rather than get overwritten). */
function collectElementCandidates(route: AppModelRoute, role: string, name: string | undefined): ElementCandidate[] {
  const out: ElementCandidate[] = [];
  let index = 0;
  for (const state of route.states) {
    for (const element of state.elements) {
      if (element.role !== role || !sameName(element.name, name)) continue;
      out.push({ state, element, index: index++ });
    }
  }
  return out;
}

/** Pick ONE candidate for attribution — mirrors recorder/replay.ts's
 * pickClearRoleWinner: score by closeness to a recorded `nth` (document-order
 * index), same `Math.max(0, 10 - |index - nth|)` shape. With no `nth` hint, or
 * no clear winner by it, fall back to the MOST RECENTLY SEEN state (the run
 * happening now is more likely to be on the newest known structural state
 * than an old one still kept for history) — a strictly better default than
 * the previous "whichever state was inserted first" behavior, though still
 * a best-effort approximation, not a guarantee, when the ledger genuinely
 * cannot tell two states apart. */
function pickElementCandidate(candidates: ElementCandidate[], nth: number | undefined): ElementCandidate | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  if (typeof nth === 'number') {
    const scored = candidates
      .map((c) => ({ c, score: Math.max(0, 10 - Math.abs(c.index - nth)) }))
      .sort((a, b) => b.score - a.score);
    if (scored[0].score > 0 && (!scored[1] || scored[1].score < scored[0].score)) return scored[0].c;
  }
  return [...candidates].sort((a, b) => b.state.lastSeenAt.localeCompare(a.state.lastSeenAt))[0];
}

/** Pure core: apply a run's steps to a model. Exported for testing without touching disk. */
export function applyRunToModel(model: AppModel, steps: StepRecord[], scriptName: string): CoverageWriteResult {
  const routesMarked = new Set<string>();
  const unknownRoutes = new Set<string>();
  let elementsMarked = 0;
  const known = new Set(model.routes.map((r) => r.route));

  for (const step of steps) {
    if (!step.url || !step.ok) continue; // a failed step touched nothing worth recording
    const route = normalizeUrlForActionCache(step.url);
    if (!known.has(route)) {
      // A33: fold it in rather than dropping it. It carries no states (the run
      // records what it touched, not the page's structure), so it counts as a
      // route the run exercised and contributes no untouched elements — an
      // honest floor, not an invented denominator.
      unknownRoutes.add(route);
      upsertRunRoute(model, route);
      known.add(route);
    }
    if (!routesMarked.has(route)) {
      markRouteExercised(model, route, scriptName);
      routesMarked.add(route);
    }
    if (!step.target) continue;
    // A51 (P2): the element is attributed to the BEST-MATCHING state across
    // the route's entire state history, not just the first one that happens
    // to contain a same-role+name element (see collectElementCandidates /
    // pickElementCandidate above for why that used to mis-attribute shared
    // elements across states). The run does not carry the structural
    // signature of the page it was on, so `step.target.nth` — the same
    // document-order disambiguator the recorder/replay path already relies
    // on — is the best signal available to resolve genuine ties; it is exact
    // whenever the route has a single matching candidate (the common case).
    const r = model.routes.find((x) => x.route === route);
    if (!r) continue;
    const candidates = collectElementCandidates(r, step.target.role, step.target.name);
    const hit = pickElementCandidate(candidates, step.target.nth);
    if (!hit) continue;
    // Pass the LEDGER's name, not the step's: markElementTouched matches
    // exactly, so handing it the AX spelling ("Email") would fail to find the
    // crawler's entry ("email") and silently mark nothing — the fuzzy match
    // has to be resolved to a concrete stored element before writing.
    markElementTouched(
      model,
      route,
      hit.state.structuralSignature,
      { role: hit.element.role, ...(hit.element.name && { name: hit.element.name }) },
      scriptName,
    );
    elementsMarked++;
  }

  return {
    ledgerPresent: true,
    routesMarked: [...routesMarked],
    elementsMarked,
    unknownRoutes: [...unknownRoutes],
  };
}

/** Load → apply → save. Never throws: coverage bookkeeping must not be able to
 * fail a QA run that otherwise succeeded. */
export function recordRunCoverage(steps: StepRecord[], scriptName: string, root = process.cwd()): CoverageWriteResult {
  const empty: CoverageWriteResult = { ledgerPresent: false, routesMarked: [], elementsMarked: 0, unknownRoutes: [] };
  try {
    const model = loadAppModel(root);
    if (!model) return empty;
    const result = applyRunToModel(model, steps, scriptName);
    saveAppModel(model, root);
    return result;
  } catch {
    return empty;
  }
}
