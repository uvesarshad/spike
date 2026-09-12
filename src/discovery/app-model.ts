/* Coverage ledger — A23 (P0), persisted at `.spike/app-model.json`.
 *
 * Tracks: routes seen (from static extraction and/or the crawl) vs
 * exercised (a script has actually run against them), interactive elements
 * discovered vs touched, which script(s) cover each, and last-exercised
 * timestamps — the concrete data `coverage.ts`'s `coverageReport()` and
 * `diff.ts`'s `diffAppModel()` both read.
 *
 * A "route" entry's identity is a plain string: a concrete normalized URL
 * for a page the crawler actually fetched, or a bare route pattern/path
 * (e.g. `/products/:id`, `/about`) for a statically-declared route the crawl
 * has not (or no longer) reached. Each route can carry more than one
 * `AppModelState` — most routes only ever have one, but the same URL can
 * legitimately present more than one structural state over time (a redesign
 * between two discovery runs; interaction-gated states from the documented
 * AI-exploration seam in `discover.ts`), and the ledger keeps history rather
 * than overwriting.
 *
 * File I/O mirrors `src/engine.ts`'s `.spike-quarantine.json` convention
 * (`loadAppModel` never throws — a missing/corrupt file just means "nothing
 * discovered yet") and `FileActionCache`'s write-tmp-then-rename pattern
 * (`src/cache/action-cache.ts`) so a crash mid-write can't corrupt the
 * ledger. */

import fs from 'node:fs';
import path from 'node:path';
import type { CrawledPage } from './crawler.js';
import type { InteractiveElement } from './html.js';

export const APP_MODEL_VERSION = 1;

export interface AppModelElement extends InteractiveElement {
  discoveredAt: string;
  touchedAt?: string;
  coveredByScripts: string[];
}

export interface AppModelState {
  structuralSignature: string;
  firstSeenAt: string;
  lastSeenAt: string;
  elements: AppModelElement[];
}

export interface AppModelRoute {
  /** Identity key — see file header. */
  route: string;
  source: 'static' | 'crawl';
  /** Collapsed pattern for a crawl-discovered concrete page (see
   * `crawler.ts`'s `collapseParameterizedPath`); absent for static routes,
   * which are already patterns. */
  routePattern?: string;
  discoveredAt: string;
  lastExercisedAt?: string;
  exercised: boolean;
  states: AppModelState[];
  coveredByScripts: string[];
}

/* --- A24: judgement -------------------------------------------------------
 *
 * Mapping used to be purely descriptive: it recorded the HTTP status of every
 * page it fetched and then never looked at it again, so a map of a site where
 * half the pages 500 came back indistinguishable from a map of a healthy one,
 * and the command exited 0 either way. These findings are that missing
 * judgement — one entry per thing the crawl saw that a person would want to
 * know about, in plain words, with a severity that decides the exit code. */

export type FindingKind =
  /** The page itself came back 5xx. */
  | 'server-error'
  /** The page itself came back 4xx (usually a stale link, not an outage). */
  | 'missing-page'
  /** The page threw an uncaught JavaScript error while loading. */
  | 'page-error'
  /** Something the page asked for afterwards failed or came back 5xx. */
  | 'request-failed'
  /** An anchor that cannot navigate anywhere (see `findDeadLinks`). */
  | 'dead-link';

/** `problem` fails the map (exit 1); `warning` is reported and does not. */
export type FindingSeverity = 'problem' | 'warning';

export interface AppModelFinding {
  /** The route (normalized URL) this was seen on. */
  route: string;
  kind: FindingKind;
  severity: FindingSeverity;
  /** One plain-English sentence a non-engineer can act on. */
  detail: string;
  status?: number;
  foundAt: string;
}

export interface AppModel {
  version: typeof APP_MODEL_VERSION;
  baseUrl?: string;
  generatedAt: string;
  routes: AppModelRoute[];
  /** What the most recent crawl judged. Replaced wholesale on every crawl —
   * a finding is a statement about the site as it is NOW, so carrying an old
   * one forward would report a page that has since been fixed. Absent on a
   * ledger written before this existed. */
  findings?: AppModelFinding[];
}

export function emptyAppModel(baseUrl?: string): AppModel {
  return { version: APP_MODEL_VERSION, ...(baseUrl && { baseUrl }), generatedAt: new Date().toISOString(), routes: [], findings: [] };
}

/** Judge one crawled page. Severity rules, in one place so the CLI, the panel
 * and the exit code can never disagree:
 *   - a 5xx page, a page that threw, or a failed same-origin request the page
 *     made → `problem`: the page is broken for whoever opens it;
 *   - a 4xx page or a link that goes nowhere → `warning`: real, worth fixing,
 *     but routinely present on healthy sites (a stale sitemap entry, an
 *     anchor used as a styling hook) and not worth failing a build over. */
export function findingsForPage(page: CrawledPage, now: string = new Date().toISOString()): AppModelFinding[] {
  const out: AppModelFinding[] = [];
  const where = page.normalizedUrl;
  if (page.status >= 500) {
    out.push({ route: where, kind: 'server-error', severity: 'problem', status: page.status, foundAt: now, detail: `This page came back with a server error (${page.status}).` });
  } else if (page.status >= 400) {
    out.push({ route: where, kind: 'missing-page', severity: 'warning', status: page.status, foundAt: now, detail: `This page was not found (${page.status}).` });
  }
  for (const err of page.pageErrors ?? []) {
    out.push({ route: where, kind: 'page-error', severity: 'problem', foundAt: now, detail: `This page hit an error while loading: ${oneLine(err)}` });
  }
  for (const req of page.failedRequests ?? []) {
    const what = req.status ? `came back with a server error (${req.status})` : `failed (${oneLine(req.errorText ?? 'no response')})`;
    out.push({ route: where, kind: 'request-failed', severity: 'problem', ...(req.status !== undefined && { status: req.status }), foundAt: now, detail: `Something this page asked for ${what}: ${req.url}` });
  }
  for (const label of page.deadLinks ?? []) {
    out.push({ route: where, kind: 'dead-link', severity: 'warning', foundAt: now, detail: `The link "${label}" does not go anywhere.` });
  }
  return out;
}

/** Collapse a multi-line error/stack down to something that fits on one line
 * of a terminal or a panel row. */
function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** True when the crawl found something that should fail the command (exit 1):
 * a page that served a server error, that threw while loading, or whose own
 * requests failed. Warnings never gate. */
export function hasBlockingFindings(findings: AppModelFinding[] | undefined): boolean {
  return (findings ?? []).some((f) => f.severity === 'problem');
}

export function appModelPath(root: string = process.cwd()): string {
  return path.join(root, '.spike', 'app-model.json');
}

/** Never throws: a missing or malformed ledger means "nothing discovered
 * yet", not a crashed run — same contract as `engine.ts`'s
 * `loadQuarantineList`. */
export function loadAppModel(root: string = process.cwd()): AppModel | null {
  const p = appModelPath(root);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as AppModel).routes)) return null;
    return raw as AppModel;
  } catch {
    return null;
  }
}

export function saveAppModel(model: AppModel, root: string = process.cwd()): void {
  const p = appModelPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(model, null, 2));
  fs.renameSync(tmp, p);
}

function findRoute(model: AppModel, route: string): AppModelRoute | undefined {
  return model.routes.find((r) => r.route === route);
}

function mergeElements(existing: AppModelElement[], discovered: InteractiveElement[], now: string): AppModelElement[] {
  const byKey = new Map<string, AppModelElement>();
  for (const e of existing) byKey.set(`${e.role}|${e.name ?? ''}`, e);
  for (const d of discovered) {
    const key = `${d.role}|${d.name ?? ''}`;
    if (!byKey.has(key)) {
      byKey.set(key, { role: d.role, ...(d.name && { name: d.name }), discoveredAt: now, coveredByScripts: [] });
    }
  }
  return [...byKey.values()];
}

/** Adds or updates a route from a freshly crawled page, preserving prior
 * coverage/exercised history for a route that was already present. Adding a
 * NEW structural signature appends a new `AppModelState` rather than
 * replacing the old one (state history, per the file header). Mutates and
 * returns the same `model` for convenience in a reduce-style caller. */
export function upsertCrawledPage(model: AppModel, page: CrawledPage, now: string = new Date().toISOString()): AppModel {
  let route = findRoute(model, page.normalizedUrl);
  if (!route) {
    route = {
      route: page.normalizedUrl,
      source: 'crawl',
      routePattern: page.routePattern,
      discoveredAt: now,
      exercised: false,
      states: [],
      coveredByScripts: [],
    };
    model.routes.push(route);
  }
  const existingState = route.states.find((s) => s.structuralSignature === page.structuralSignature);
  if (existingState) {
    existingState.lastSeenAt = now;
    existingState.elements = mergeElements(existingState.elements, page.interactiveElements, now);
  } else {
    route.states.push({
      structuralSignature: page.structuralSignature,
      firstSeenAt: now,
      lastSeenAt: now,
      elements: mergeElements([], page.interactiveElements, now),
    });
  }
  return model;
}

/** Adds a statically-declared route pattern (from sitemap/robots/Next.js dir
 * extraction) that isn't already present as a crawl-discovered route. A
 * no-op if the route already exists under either source — static extraction
 * runs first in `discover.ts`'s ladder and must not clobber a richer entry a
 * later crawl fills in for the same identity string. */
export function upsertStaticRoute(model: AppModel, route: string, now: string = new Date().toISOString()): AppModel {
  if (findRoute(model, route)) return model;
  model.routes.push({ route, source: 'static', discoveredAt: now, exercised: false, states: [], coveredByScripts: [] });
  return model;
}

/** Records that `scriptName` exercised `route` — the ledger half of "which
 * script covers each" and "last-exercised timestamps". A caller (a future
 * CLI/loop integration, outside this module's scope) invokes this after a
 * recorded/replayed script actually runs against a route. */
export function markRouteExercised(model: AppModel, route: string, scriptName: string, now: string = new Date().toISOString()): AppModel {
  const r = findRoute(model, route);
  if (!r) return model;
  r.exercised = true;
  r.lastExercisedAt = now;
  if (!r.coveredByScripts.includes(scriptName)) r.coveredByScripts.push(scriptName);
  return model;
}

/** Records that `scriptName` actually interacted with a specific element
 * (role+name) within a specific state of `route` — the ledger half of
 * "interactive elements discovered vs touched". */
export function markElementTouched(
  model: AppModel,
  route: string,
  structuralSignature: string,
  element: { role: string; name?: string },
  scriptName: string,
  now: string = new Date().toISOString(),
): AppModel {
  const r = findRoute(model, route);
  const state = r?.states.find((s) => s.structuralSignature === structuralSignature);
  const el = state?.elements.find((e) => e.role === element.role && (e.name ?? '') === (element.name ?? ''));
  if (!el) return model;
  el.touchedAt = now;
  if (!el.coveredByScripts.includes(scriptName)) el.coveredByScripts.push(scriptName);
  return model;
}
