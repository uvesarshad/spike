/* Change-triggered re-exploration — A25 (P1).
 *
 * Pure + crawl-only, per the task: `diffAppModel` spends no model calls. It
 * fingerprints two `AppModel` snapshots (route set + per-route structural
 * signature set) and classifies every route into new / changed / removed /
 * unchanged, then orders the actionable ones by the priority the options doc
 * specifies (26-08-08-options-autonomy-layer.md, A25 "Budget"): *newly-added
 * surface > changed surface with existing coverage > changed surface without
 * coverage*. Removed routes need no AI spend (they are retired, not
 * authored) so they sort after the priority-queue candidates — a caller
 * still gets them for the "retire + report" side of A25's "Response" table.
 *
 * `previous` is typically a ledger loaded via `loadAppModel()` (the
 * previously persisted `.spike/app-model.json`); `current` is a fresh,
 * unmerged result of `discoverApp()` run again. Route identity is the same
 * plain string used throughout `app-model.ts` (a concrete normalized URL or
 * a static route pattern) — both snapshots must have been produced against
 * the same site for the comparison to be meaningful, which callers control,
 * not this module. */

import type { AppModel, AppModelRoute } from './app-model.js';

export type DiffKind = 'new-route' | 'changed-route' | 'removed-route';

export interface AppModelDiffEntry {
  route: string;
  kind: DiffKind;
  /** Whether the route had ANY prior coverage (exercised, or at least one
   * script attached) before this diff — the signal the priority order uses
   * to rank "changed-with-coverage" ahead of "changed-without-coverage". Not
   * meaningful (always false) for `new-route`. */
  hasCoverage: boolean;
  previousSignatures?: string[];
  currentSignatures?: string[];
}

export interface AppModelDiff {
  newRoutes: AppModelDiffEntry[];
  changedRoutes: AppModelDiffEntry[];
  removedRoutes: AppModelDiffEntry[];
  unchangedRoutes: string[];
  /** Drain order for a budgeted caller: new surface, then changed-with-
   * coverage, then changed-without-coverage, then removed (report/retire
   * only — no AI spend). Ties within a bucket keep the route's
   * lexicographic order for determinism. */
  prioritized: AppModelDiffEntry[];
}

function signatureSet(route: AppModelRoute): string[] {
  return [...new Set(route.states.map((s) => s.structuralSignature))].sort();
}

function hasAnyCoverage(route: AppModelRoute): boolean {
  return route.exercised || route.coveredByScripts.length > 0;
}

function sameSignatureSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((sig, i) => sig === b[i]);
}

export function diffAppModel(previous: AppModel, current: AppModel): AppModelDiff {
  const previousByRoute = new Map(previous.routes.map((r) => [r.route, r]));
  const currentByRoute = new Map(current.routes.map((r) => [r.route, r]));

  const newRoutes: AppModelDiffEntry[] = [];
  const changedRoutes: AppModelDiffEntry[] = [];
  const unchangedRoutes: string[] = [];

  for (const route of [...currentByRoute.keys()].sort()) {
    const curr = currentByRoute.get(route)!;
    const prev = previousByRoute.get(route);
    if (!prev) {
      newRoutes.push({ route, kind: 'new-route', hasCoverage: false, currentSignatures: signatureSet(curr) });
      continue;
    }
    const prevSigs = signatureSet(prev);
    const currSigs = signatureSet(curr);
    if (sameSignatureSet(prevSigs, currSigs)) {
      unchangedRoutes.push(route);
    } else {
      changedRoutes.push({
        route,
        kind: 'changed-route',
        hasCoverage: hasAnyCoverage(prev),
        previousSignatures: prevSigs,
        currentSignatures: currSigs,
      });
    }
  }

  const removedRoutes: AppModelDiffEntry[] = [...previousByRoute.keys()]
    .filter((route) => !currentByRoute.has(route))
    .sort()
    .map((route) => ({ route, kind: 'removed-route' as const, hasCoverage: hasAnyCoverage(previousByRoute.get(route)!), previousSignatures: signatureSet(previousByRoute.get(route)!) }));

  const changedWithCoverage = changedRoutes.filter((c) => c.hasCoverage);
  const changedWithoutCoverage = changedRoutes.filter((c) => !c.hasCoverage);

  const prioritized: AppModelDiffEntry[] = [...newRoutes, ...changedWithCoverage, ...changedWithoutCoverage, ...removedRoutes];

  return { newRoutes, changedRoutes, removedRoutes, unchangedRoutes, prioritized };
}
