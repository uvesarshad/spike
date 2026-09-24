/* A7 — `spike map --diff` → "check the pages that changed".
 * Restricts the check fan-out to the routes the diff flagged as new or changed
 * (removed routes have nothing to open). The checker is injected so the caller
 * chooses the transport and tests use a stub. */

import type { AppModel } from './app-model.js';
import type { AppModelDiff } from './diff.js';
import { checkTargets, type CheckTarget } from './site-check.js';

export function changedTargets(model: AppModel, diff: AppModelDiff, baseUrl: string, max = 1000): CheckTarget[] {
  const changed = new Set([...diff.newRoutes, ...diff.changedRoutes].map((e) => e.route));
  return checkTargets({ ...model, routes: model.routes.filter((r) => changed.has(r.route)) }, baseUrl, max);
}

export async function runChangedPages<T>(
  model: AppModel,
  diff: AppModelDiff,
  baseUrl: string,
  checker: (targets: CheckTarget[]) => Promise<T>,
): Promise<{ targets: CheckTarget[]; result: T | null }> {
  const targets = changedTargets(model, diff, baseUrl);
  if (!targets.length) return { targets, result: null };
  return { targets, result: await checker(targets) };
}
