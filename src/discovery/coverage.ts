/* Coverage math — A23's "what haven't we tested?" answer.
 *
 * Per the options doc (26-08-08-options-autonomy-layer.md, A23 "Coverage
 * metric"): report route coverage (legible, weak signal) AND
 * interactive-element coverage (elements touched / elements discovered —
 * "the metric that actually answers 'what haven't we tested?'"), both
 * derivable directly from the `AppModel` the discovery pass already builds. */

import type { AppModel } from './app-model.js';

export interface RouteCoverage {
  total: number;
  exercised: number;
  /** exercised/total, 0 when total is 0 (never NaN/Infinity). */
  ratio: number;
}

export interface ElementCoverage {
  total: number;
  touched: number;
  ratio: number;
}

export interface RouteCoverageDetail {
  route: string;
  exercised: boolean;
  lastExercisedAt?: string;
  elementsTotal: number;
  elementsTouched: number;
  coveredByScripts: string[];
}

export interface CoverageReport {
  routes: RouteCoverage;
  interactiveElements: ElementCoverage;
  perRoute: RouteCoverageDetail[];
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

export function coverageReport(model: AppModel): CoverageReport {
  const totalRoutes = model.routes.length;
  const exercisedRoutes = model.routes.filter((r) => r.exercised).length;

  let elementsTotal = 0;
  let elementsTouched = 0;
  const perRoute: RouteCoverageDetail[] = model.routes.map((r) => {
    const allElements = r.states.flatMap((s) => s.elements);
    const touched = allElements.filter((e) => e.touchedAt !== undefined).length;
    elementsTotal += allElements.length;
    elementsTouched += touched;
    return {
      route: r.route,
      exercised: r.exercised,
      ...(r.lastExercisedAt && { lastExercisedAt: r.lastExercisedAt }),
      elementsTotal: allElements.length,
      elementsTouched: touched,
      coveredByScripts: r.coveredByScripts,
    };
  });

  return {
    routes: { total: totalRoutes, exercised: exercisedRoutes, ratio: safeRatio(exercisedRoutes, totalRoutes) },
    interactiveElements: { total: elementsTotal, touched: elementsTouched, ratio: safeRatio(elementsTouched, elementsTotal) },
    perRoute,
  };
}
