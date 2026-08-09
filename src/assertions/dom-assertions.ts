/* A5 (P0) — precise assertion vocabulary. The pre-existing `assert_dom`
 * action (src/driver/loop.ts) is a case-insensitive SUBSTRING match only —
 * on a large app `assert_dom contains "Order"` passes on the orders list,
 * the confirmation page, an "Order failed" toast, and a nav link. Even a
 * correct AI verdict has no primitive precise enough to encode what it
 * verified. This module adds exact-equality, element-count, URL, node-state,
 * network-status, and console-error assertions.
 *
 * PURE evaluator: no CDP, no I/O, no imports from driver/loop.ts or any port
 * implementation — just the BrowserPort types plus a url string in, a
 * pass/fail verdict out. driver/loop.ts (owned by the coordinator) is
 * expected to call evaluateAssertion() and wire the result into the step
 * record the same way it already handles assert_dom/assert_visual.
 *
 * `assert_dom` itself is UNTOUCHED — it stays exactly as it is in loop.ts
 * (case-insensitive substring over subtree text via findNode/subtreeText
 * there). The verbs here are additive, not a replacement, so recorded
 * scripts and the action cache (which reference assert_dom by name) keep
 * working unchanged. */

import type { AxNode, AxSnapshot, ConsoleEntry, NetworkEntry } from '../ports/browser-port.js';

// ---------------------------------------------------------------------------
// Spec types (discriminated union, one per verb in driver/actions.ts)
// ---------------------------------------------------------------------------

export interface AssertTextSpec {
  type: 'assert_text';
  /** AX nodeId to scope the check to; omitted = whole serialized page text. */
  target?: string;
  mode: 'exact' | 'contains' | 'regex';
  value: string;
}

export interface AssertCountSpec {
  type: 'assert_count';
  role: string;
  /** Omitted = match by role only (name filter not applied). */
  name?: string;
  expected: number;
  comparator: 'eq' | 'gte' | 'lte';
}

export interface AssertUrlSpec {
  type: 'assert_url';
  mode: 'exact' | 'contains' | 'regex';
  value: string;
}

export interface AssertStateSpec {
  type: 'assert_state';
  /** AX nodeId. */
  target: string;
  state: 'visible' | 'hidden' | 'enabled' | 'disabled' | 'checked' | 'focused';
}

export interface AssertNetworkSpec {
  type: 'assert_network';
  /** Regex source tested against each NetworkEntry.url. */
  urlPattern: string;
  status?: number;
  statusClass?: '2xx' | '3xx' | '4xx' | '5xx';
  /** true = assert NO entry matched the pattern (+ status/statusClass filters). */
  absent?: boolean;
}

export interface AssertNoConsoleErrorsSpec {
  type: 'assert_no_console_errors';
  /** Substrings (case-insensitive) that are OK to see and should not fail the run. */
  allow?: string[];
}

export type AssertionSpec =
  | AssertTextSpec
  | AssertCountSpec
  | AssertUrlSpec
  | AssertStateSpec
  | AssertNetworkSpec
  | AssertNoConsoleErrorsSpec;

export interface AssertionContext {
  ax: AxSnapshot;
  url: string;
  network: NetworkEntry[];
  console: ConsoleEntry[];
}

export interface AssertionResult {
  ok: boolean;
  /** Human-readable: what was expected vs what was actually found. Lands in
   * reports and the fix prompt, so it must stand alone without the spec. */
  detail: string;
  actual?: string;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Local re-implementation of loop.ts's findNode — this module must stay
 * import-free of driver/loop.ts (pure, no CDP/I-O dependency), so the tiny
 * tree walk is duplicated here rather than imported. */
function findNode(root: AxNode, id: string): AxNode | undefined {
  if (root.id === id) return root;
  for (const c of root.children ?? []) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return undefined;
}

/** Local re-implementation of loop.ts's subtreeText — see findNode's comment. */
function subtreeText(node: AxNode): string {
  const parts: string[] = [];
  const walk = (n: AxNode): void => {
    if (n.name) parts.push(n.name);
    if (n.value) parts.push(n.value);
    for (const c of n.children ?? []) walk(c);
  };
  walk(node);
  return parts.join(' ');
}

function collapseWhitespace(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

/** Compiles a regex defensively: an invalid pattern must FAIL the assertion,
 * never throw and crash the run. Returns null on invalid input. */
function compileRegexSafe(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

function truncate(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Count AX nodes matching role (+ optional exact name), pre-order. Mirrors
 * loop.ts's rankByRoleName counting semantics (role === role && name ===
 * name when a name filter is given). */
function countByRoleName(root: AxNode, role: string, name?: string): number {
  let count = 0;
  const walk = (n: AxNode): void => {
    if (n.role === role && (name === undefined || n.name === name)) count++;
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return count;
}

function compareCount(actual: number, expected: number, comparator: 'eq' | 'gte' | 'lte'): boolean {
  switch (comparator) {
    case 'eq':
      return actual === expected;
    case 'gte':
      return actual >= expected;
    case 'lte':
      return actual <= expected;
  }
}

/** Minimal duplicate of src/cache/action-cache.ts's normalizeUrlForActionCache
 * — that module is owned by another agent in this sweep, so the intent
 * (lowercase scheme/host, normalize path, drop tracking params, sort the
 * rest) is mirrored locally rather than imported. Keep in sync by hand if
 * the real implementation's normalization rules change. Falls back to a
 * trimmed/lowercased string on parse failure, same as the original. */
function normalizeUrlForAssertion(input: string): string {
  try {
    const u = new URL(input);
    const protocol = u.protocol.toLowerCase();
    const hostname = u.hostname.toLowerCase();
    const host = u.port ? `${hostname}:${u.port}` : hostname;
    const cleanPath = u.pathname.replace(/\/{2,}/g, '/');
    const pathname = cleanPath === '' || cleanPath === '/' ? '/' : cleanPath.endsWith('/') ? cleanPath.slice(0, -1) : cleanPath;
    const TRACKING_QUERY_RE = /^(utm_|fbclid$|gclid$|msclkid$)/i;
    const params = [...u.searchParams.entries()]
      .filter(([k]) => !TRACKING_QUERY_RE.test(k))
      .sort(([a], [b]) => a.localeCompare(b));
    const query = params.length ? `?${params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}` : '';
    return `${protocol}//${host}${pathname}${query}`;
  } catch {
    return input.trim().replace(/\s+/g, ' ').toLowerCase();
  }
}

/** Classifies a NetworkEntry into a status class even when `status` itself is
 * absent: `failed` (5xx/transport failure) and `clientError` (4xx) are set by
 * capture/console-network.ts's drain independent of a numeric status — see
 * NetworkEntry's own doc comments in ports/browser-port.ts. */
function statusClassOf(entry: NetworkEntry): '2xx' | '3xx' | '4xx' | '5xx' | undefined {
  if (typeof entry.status === 'number') {
    const c = Math.floor(entry.status / 100);
    if (c >= 2 && c <= 5) return `${c}xx` as '2xx' | '3xx' | '4xx' | '5xx';
    return undefined;
  }
  if (entry.failed) return '5xx';
  if (entry.clientError) return '4xx';
  return undefined;
}

// ---------------------------------------------------------------------------
// Per-verb evaluators
// ---------------------------------------------------------------------------

function evalAssertText(spec: AssertTextSpec, ctx: AssertionContext): AssertionResult {
  let hay: string;
  if (spec.target) {
    const node = findNode(ctx.ax.root, spec.target);
    if (!node) return { ok: false, detail: `assert_text: target node "${spec.target}" not found in current page` };
    hay = subtreeText(node);
  } else {
    hay = ctx.ax.text;
  }

  if (spec.mode === 'exact') {
    const a = collapseWhitespace(hay);
    const b = collapseWhitespace(spec.value);
    const ok = a === b;
    return { ok, detail: `assert_text exact: expected ${JSON.stringify(b)}, found ${JSON.stringify(truncate(a))}`, actual: a };
  }
  if (spec.mode === 'contains') {
    // preserves today's assert_dom case-insensitive substring semantics
    const ok = hay.toLowerCase().includes(spec.value.toLowerCase());
    return {
      ok,
      detail: ok
        ? `assert_text contains: found ${JSON.stringify(spec.value)}`
        : `assert_text contains: expected to find ${JSON.stringify(spec.value)}, found ${JSON.stringify(truncate(hay))}`,
      actual: hay,
    };
  }
  // regex
  const re = compileRegexSafe(spec.value);
  if (!re) return { ok: false, detail: `assert_text regex: invalid pattern ${JSON.stringify(spec.value)}`, actual: hay };
  const ok = re.test(hay);
  return {
    ok,
    detail: ok
      ? `assert_text regex: ${JSON.stringify(spec.value)} matched`
      : `assert_text regex: ${JSON.stringify(spec.value)} did not match ${JSON.stringify(truncate(hay))}`,
    actual: hay,
  };
}

function evalAssertCount(spec: AssertCountSpec, ctx: AssertionContext): AssertionResult {
  const actual = countByRoleName(ctx.ax.root, spec.role, spec.name);
  const ok = compareCount(actual, spec.expected, spec.comparator);
  const target = spec.name ? `role "${spec.role}" name ${JSON.stringify(spec.name)}` : `role "${spec.role}"`;
  return {
    ok,
    detail: `assert_count: expected count ${spec.comparator} ${spec.expected} for ${target}, found ${actual}`,
    actual: String(actual),
  };
}

function evalAssertUrl(spec: AssertUrlSpec, ctx: AssertionContext): AssertionResult {
  if (spec.mode === 'exact') {
    const a = normalizeUrlForAssertion(ctx.url);
    const b = normalizeUrlForAssertion(spec.value);
    const ok = a === b;
    return { ok, detail: `assert_url exact: expected ${JSON.stringify(b)}, found ${JSON.stringify(a)}`, actual: ctx.url };
  }
  if (spec.mode === 'contains') {
    const ok = ctx.url.toLowerCase().includes(spec.value.toLowerCase());
    return {
      ok,
      detail: ok
        ? `assert_url contains: found ${JSON.stringify(spec.value)} in ${JSON.stringify(ctx.url)}`
        : `assert_url contains: expected to find ${JSON.stringify(spec.value)} in ${JSON.stringify(ctx.url)}`,
      actual: ctx.url,
    };
  }
  const re = compileRegexSafe(spec.value);
  if (!re) return { ok: false, detail: `assert_url regex: invalid pattern ${JSON.stringify(spec.value)}`, actual: ctx.url };
  const ok = re.test(ctx.url);
  return {
    ok,
    detail: ok
      ? `assert_url regex: ${JSON.stringify(spec.value)} matched ${JSON.stringify(ctx.url)}`
      : `assert_url regex: ${JSON.stringify(spec.value)} did not match ${JSON.stringify(ctx.url)}`,
    actual: ctx.url,
  };
}

function evalAssertState(spec: AssertStateSpec, ctx: AssertionContext): AssertionResult {
  const node = findNode(ctx.ax.root, spec.target);
  if (!node) {
    // A node absent from the AX tree entirely IS the observable signal for
    // "hidden" (getFullAXTree omits genuinely hidden nodes) — for every other
    // state we cannot positively verify anything about a node that isn't there.
    if (spec.state === 'hidden') return { ok: true, detail: `assert_state hidden: target "${spec.target}" is not present in the current tree (treated as hidden)` };
    return { ok: false, detail: `assert_state ${spec.state}: target "${spec.target}" not found in current page` };
  }
  const states = node.states ?? [];
  const has = (s: string) => states.includes(s);
  let ok: boolean;
  switch (spec.state) {
    case 'visible':
      ok = !has('hidden') && !has('invisible');
      break;
    case 'hidden':
      ok = has('hidden') || has('invisible');
      break;
    case 'enabled':
      ok = !has('disabled');
      break;
    case 'disabled':
      ok = has('disabled');
      break;
    case 'checked':
      ok = has('checked');
      break;
    case 'focused':
      ok = has('focused');
      break;
  }
  return {
    ok,
    detail: `assert_state: expected "${spec.target}" to be ${spec.state}, actual states: [${states.join(', ')}]`,
    actual: states.join(', '),
  };
}

function evalAssertNetwork(spec: AssertNetworkSpec, ctx: AssertionContext): AssertionResult {
  const re = compileRegexSafe(spec.urlPattern);
  if (!re) return { ok: false, detail: `assert_network: invalid urlPattern ${JSON.stringify(spec.urlPattern)}` };

  const matches = ctx.network.filter((e) => {
    if (!re.test(e.url)) return false;
    if (spec.status !== undefined && e.status !== spec.status) return false;
    if (spec.statusClass !== undefined && statusClassOf(e) !== spec.statusClass) return false;
    return true;
  });

  const filterDesc = [
    `url~${JSON.stringify(spec.urlPattern)}`,
    spec.status !== undefined ? `status=${spec.status}` : null,
    spec.statusClass !== undefined ? `statusClass=${spec.statusClass}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  if (spec.absent) {
    const ok = matches.length === 0;
    return {
      ok,
      detail: ok
        ? `assert_network absent: no request matched (${filterDesc})`
        : `assert_network absent: expected NO request matching (${filterDesc}), found ${matches.length}: ${matches.map((m) => m.url).slice(0, 5).join(', ')}`,
      actual: String(matches.length),
    };
  }
  const ok = matches.length > 0;
  return {
    ok,
    detail: ok
      ? `assert_network: found ${matches.length} matching request(s) (${filterDesc})`
      : `assert_network: expected a request matching (${filterDesc}), found none among ${ctx.network.length} recorded`,
    actual: String(matches.length),
  };
}

function evalAssertNoConsoleErrors(spec: AssertNoConsoleErrorsSpec, ctx: AssertionContext): AssertionResult {
  const allow = spec.allow ?? [];
  const isAllowed = (text: string) => allow.some((a) => text.toLowerCase().includes(a.toLowerCase()));
  const offenders = ctx.console.filter((e) => (e.level === 'page-error' || e.level === 'error') && !isAllowed(e.text));
  const ok = offenders.length === 0;
  return {
    ok,
    detail: ok
      ? 'assert_no_console_errors: no unallowed error/page-error entries'
      : `assert_no_console_errors: ${offenders.length} unallowed error(s): ${offenders.map((o) => truncate(o.text, 100)).slice(0, 5).join(' | ')}`,
    actual: String(offenders.length),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function evaluateAssertion(spec: AssertionSpec, ctx: AssertionContext): AssertionResult {
  switch (spec.type) {
    case 'assert_text':
      return evalAssertText(spec, ctx);
    case 'assert_count':
      return evalAssertCount(spec, ctx);
    case 'assert_url':
      return evalAssertUrl(spec, ctx);
    case 'assert_state':
      return evalAssertState(spec, ctx);
    case 'assert_network':
      return evalAssertNetwork(spec, ctx);
    case 'assert_no_console_errors':
      return evalAssertNoConsoleErrors(spec, ctx);
  }
}
