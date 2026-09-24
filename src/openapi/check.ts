/* E8 — spec-derived checks: compare the API calls a run actually made against
 * an OpenAPI description of the app's API. Pure: give it the spec and the
 * network entries; get back the mismatches.
 *
 * What it can judge from a run's recorded traffic (method, address, status —
 * bodies are not kept): a call to a path the spec does not describe, a method
 * the spec does not allow on a path, and a status code the spec does not list
 * for that call. It does not validate response bodies. JSON specs only (no
 * YAML parser ships with the package); OpenAPI 3.x and Swagger 2.0 both read. */

import type { NetworkEntry } from '../ports/browser-port.js';

export interface ParsedSpec {
  /** Path templates (`/users/{id}`) → lower-case method → documented status keys (`200`, `2XX`, `default`). */
  paths: Map<string, Map<string, Set<string>>>;
  /** Path prefixes the API lives under (from `servers` / `basePath`), `''` when at the root. */
  basePaths: string[];
  /** Origins named by `servers` (absolute ones only). */
  origins: string[];
}

export class OpenApiError extends Error {}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

export function parseOpenApi(text: string): ParsedSpec {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new OpenApiError('Could not read that file. Only JSON API descriptions are supported (convert YAML to JSON first).');
  }
  if (!doc || typeof doc !== 'object' || (!doc.openapi && !doc.swagger) || typeof doc.paths !== 'object' || !doc.paths) {
    throw new OpenApiError('That does not look like an OpenAPI description (no "openapi"/"swagger" version or "paths").');
  }
  const paths = new Map<string, Map<string, Set<string>>>();
  for (const [tpl, item] of Object.entries(doc.paths as Record<string, Record<string, unknown>>)) {
    const ms = new Map<string, Set<string>>();
    for (const m of METHODS) {
      const op = item?.[m] as { responses?: Record<string, unknown> } | undefined;
      if (op && typeof op === 'object') ms.set(m, new Set(Object.keys(op.responses ?? {}).map((k) => k.toUpperCase())));
    }
    paths.set(tpl, ms);
  }
  const basePaths = new Set<string>();
  const origins = new Set<string>();
  for (const s of (doc.servers as Array<{ url?: string }> | undefined) ?? []) {
    if (!s?.url) continue;
    try {
      const u = new URL(s.url);
      origins.add(u.origin);
      basePaths.add(u.pathname.replace(/\/+$/, ''));
    } catch {
      basePaths.add(s.url.replace(/\/+$/, '')); // relative server url = a base path
    }
  }
  if (typeof doc.basePath === 'string') basePaths.add(doc.basePath.replace(/\/+$/, ''));
  if (!basePaths.size) basePaths.add('');
  return { paths, basePaths: [...basePaths], origins: [...origins] };
}

function templateToRegex(tpl: string): RegExp {
  const src = tpl.split('/').map((seg) => seg.replace(/\{[^}]+\}|[^{}]+/g, (m) => (m.startsWith('{') ? '[^/]+' : m.replace(/[.+^$()|[\]\\*?]/g, '\\$&')))).join('/');
  return new RegExp(`^${src}/?$`);
}

export interface ApiMismatch {
  method: string;
  path: string;
  status?: number;
  kind: 'undocumented-path' | 'method-not-allowed' | 'undocumented-status';
  what: string;
}

export interface ApiCheckResult {
  /** Calls that fell under the API's address and were compared. */
  checked: number;
  mismatches: ApiMismatch[];
  summary: string;
}

export interface ApiCheckOptions {
  /** The app's own origin (the run's site). Calls to other origins are ignored unless the spec names them. */
  origin?: string;
}

export function checkApiCalls(spec: ParsedSpec, calls: NetworkEntry[], opts: ApiCheckOptions = {}): ApiCheckResult {
  const specOrigins = new Set([...spec.origins, ...(opts.origin ? [new URL(opts.origin).origin] : [])]);
  const compiled = [...spec.paths.entries()].map(([tpl, methods]) => ({ tpl, methods, re: templateToRegex(tpl) }));
  const mismatches: ApiMismatch[] = [];
  const seen = new Set<string>();
  let checked = 0;

  for (const call of calls) {
    let u: URL;
    try { u = new URL(call.url); } catch { continue; }
    if (specOrigins.size && !specOrigins.has(u.origin)) continue;
    const base = spec.basePaths.filter((b) => b === '' || u.pathname === b || u.pathname.startsWith(`${b}/`)).sort((a, b) => b.length - a.length)[0];
    if (base === undefined) continue;
    const rel = u.pathname.slice(base.length) || '/';
    // With no named base path, only paths that look like an API are judged, so page loads and assets are not "undocumented".
    if (base === '' && spec.basePaths.length === 1 && !compiled.some((c) => c.re.test(rel)) && !/^\/(api|v\d+)(\/|$)/i.test(rel)) continue;
    const method = call.method.toLowerCase();
    const hit = compiled.find((c) => c.re.test(rel));
    checked++;
    const key = `${method} ${rel} ${call.status ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!hit) {
      mismatches.push({ method: call.method, path: rel, ...(call.status !== undefined && { status: call.status }), kind: 'undocumented-path', what: `${call.method} ${rel} is not in the API description.` });
      continue;
    }
    const statuses = hit.methods.get(method);
    if (!statuses) {
      mismatches.push({ method: call.method, path: rel, ...(call.status !== undefined && { status: call.status }), kind: 'method-not-allowed', what: `${hit.tpl} does not allow ${call.method} in the API description.` });
      continue;
    }
    if (call.status === undefined || statuses.size === 0) continue;
    const s = String(call.status);
    if (!statuses.has(s) && !statuses.has(`${s[0]}XX`) && !statuses.has('DEFAULT')) {
      mismatches.push({ method: call.method, path: rel, status: call.status, kind: 'undocumented-status', what: `${call.method} ${hit.tpl} answered ${call.status}, which the API description does not list (it lists ${[...statuses].join(', ')}).` });
    }
  }
  const summary = mismatches.length
    ? `${mismatches.length} of ${checked} API call${checked === 1 ? '' : 's'} did not match the API description.`
    : checked
      ? `All ${checked} API call${checked === 1 ? '' : 's'} matched the API description.`
      : 'No API calls in this run fell under the API description.';
  return { checked, mismatches, summary };
}
