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
 * run must never fail because a bookkeeping file is absent. Routes the model
 * has never seen are skipped rather than invented: the ledger's job is to
 * report coverage of a KNOWN surface, and silently growing it from whatever a
 * run happened to touch would make "discovered" mean two different things.
 */

import { normalizeUrlForActionCache } from '../cache/action-cache.js';
import type { StepRecord } from '../report/report.js';
import { loadAppModel, markElementTouched, markRouteExercised, saveAppModel, type AppModel } from './app-model.js';

export interface CoverageWriteResult {
  /** False when there is no ledger yet — the normal state before `spike map`. */
  ledgerPresent: boolean;
  routesMarked: string[];
  elementsMarked: number;
  /** Routes the run visited that the ledger has never discovered. Surfaced
   * rather than added: a run reaching surface the crawler could not (an
   * interaction-gated route) is exactly the signal that the AI-exploration
   * seam is needed — see discover.ts. */
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
 * `id="user_email"` still will not match. Properly fixing it means teaching the
 * HTML extractor to compute accessible names (label association, aria-label,
 * placeholder fallback); tracked as a follow-up rather than papered over here. */
function sameName(a: string | undefined, b: string | undefined): boolean {
  return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
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
      unknownRoutes.add(route);
      continue;
    }
    if (!routesMarked.has(route)) {
      markRouteExercised(model, route, scriptName);
      routesMarked.add(route);
    }
    if (!step.target) continue;
    // The element is attributed to whichever recorded state of this route
    // actually lists it — the run does not carry the structural signature of
    // the page it was on, and re-deriving one here would need a snapshot we no
    // longer have. Matching by role+name across the route's known states is
    // the honest approximation, and it is exact whenever the route has a
    // single state (the common case).
    const r = model.routes.find((x) => x.route === route);
    for (const state of r?.states ?? []) {
      const hit = state.elements.find(
        (e) => e.role === step.target!.role && sameName(e.name, step.target!.name),
      );
      if (!hit) continue;
      // Pass the LEDGER's name, not the step's: markElementTouched matches
      // exactly, so handing it the AX spelling ("Email") would fail to find the
      // crawler's entry ("email") and silently mark nothing — the fuzzy match
      // has to be resolved to a concrete stored element before writing.
      markElementTouched(model, route, state.structuralSignature, { role: hit.role, ...(hit.name && { name: hit.name }) }, scriptName);
      elementsMarked++;
      break;
    }
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
