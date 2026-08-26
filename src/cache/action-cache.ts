import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Action } from '../driver/actions.js';
import type { AxNode, AxSnapshot, BrowserPort } from '../ports/browser-port.js';
import type { StepTarget } from '../report/report.js';

export const ACTION_CACHE_VERSION = 1;

export type CacheableActionType =
  | 'navigate'
  | 'click'
  | 'type'
  | 'hover'
  | 'press_key'
  | 'select_option'
  | 'reload'
  | 'go_back'
  | 'wait'
  | 'assert_dom'
  | 'extract';

export interface ActionCacheKey {
  version: typeof ACTION_CACHE_VERSION;
  id: string;
  normalizedUrl: string;
  normalizedGoal: string;
  actionIntent: string;
  pageSignature: string;
}

export interface ActionCacheKeyInput {
  url: string;
  goal: string;
  action: Action;
  page: AxSnapshot | string;
  target?: StepTarget;
}

export interface CachedTarget {
  role: string;
  name?: string;
  nth?: number;
  qaId?: string;
}

export type CachedActionValue =
  | { type: 'navigate'; url: string }
  | { type: 'click'; target: CachedTarget }
  | { type: 'type'; target: CachedTarget; text: string }
  | { type: 'hover'; target: CachedTarget }
  | { type: 'press_key'; key: string }
  | { type: 'select_option'; target: CachedTarget; value: string }
  | { type: 'reload' }
  | { type: 'go_back' }
  | { type: 'wait'; ms: number }
  | { type: 'assert_dom'; target: CachedTarget; contains: string }
  | { type: 'extract'; target: CachedTarget; key: string; pattern?: string };

export interface ActionCacheRecord {
  version: typeof ACTION_CACHE_VERSION;
  key: ActionCacheKey;
  value: CachedActionValue;
  createdAt: string;
  hitCount: number;
  lastHitAt?: string;
  metadata?: {
    sourceRunId?: string;
    sourceStepIndex?: number;
    note?: string;
  };
}

export interface ActionEffectState {
  url: string;
  normalizedUrl: string;
  pageSignature: string;
  capturedAt: number;
  ax: AxSnapshot;
}

export interface ActionEffectResult {
  ok: boolean;
  reason: string;
  changes: string[];
}

const SECRET_PLACEHOLDER_RE = /\{\{secret:([a-zA-Z0-9_-]+)\}\}/g;
const TRACKING_QUERY_RE = /^(utm_|fbclid$|gclid$|msclkid$)/i;
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/,
];
const CREDENTIAL_TARGET_RE = /\b(password|passcode|api\s*key|secret|token|otp|mfa|2fa|authorization)\b/i;

export class ActionCacheRejectedError extends Error {}

export function normalizeUrlForActionCache(input: string): string {
  try {
    const u = new URL(input);
    const protocol = u.protocol.toLowerCase();
    const hostname = u.hostname.toLowerCase();
    const host = u.port ? `${hostname}:${u.port}` : hostname;
    const pathname = normalizePathname(u.pathname);
    const params = [...u.searchParams.entries()]
      .filter(([k]) => !TRACKING_QUERY_RE.test(k))
      .sort(([a], [b]) => a.localeCompare(b));
    const query = params.length
      ? `?${params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`
      : '';
    return `${protocol}//${host}${pathname}${query}`;
  } catch {
    return input.trim().replace(/\s+/g, ' ').toLowerCase();
  }
}

export function normalizeGoalForActionCache(goal: string): string {
  return redactSecretLikeText(goal).trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 240);
}

export function pageSignatureFromAx(ax: AxSnapshot | string): string {
  const material = typeof ax === 'string' ? ax : stableAxMaterial(ax.root);
  const normalized = redactSecretLikeText(material)
    .replace(/\bn\d+\b/g, 'n*')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12_000);
  return sha256(normalized);
}

export function buildActionCacheKey(input: ActionCacheKeyInput): ActionCacheKey {
  const normalizedUrl = normalizeUrlForActionCache(input.url);
  const normalizedGoal = normalizeGoalForActionCache(input.goal);
  const actionIntent = actionIntentForKey(input.action, input.target);
  const pageSignature = pageSignatureFromAx(input.page);
  const id = sha256(
    JSON.stringify({
      version: ACTION_CACHE_VERSION,
      normalizedUrl,
      normalizedGoal,
      actionIntent,
      pageSignature,
    }),
  );
  return { version: ACTION_CACHE_VERSION, id, normalizedUrl, normalizedGoal, actionIntent, pageSignature };
}

export function toCachedActionValue(action: Action, target?: StepTarget): CachedActionValue {
  switch (action.type) {
    case 'navigate':
      assertNoSecretText(action.url, 'navigate.url');
      return { type: 'navigate', url: normalizeUrlForActionCache(action.url) };
    case 'click':
      return { type: 'click', target: requireCachedTarget(target, action.type) };
    case 'type': {
      const cachedTarget = requireCachedTarget(target, action.type);
      assertTypeTextCanBeCached(action.text, cachedTarget);
      return { type: 'type', target: cachedTarget, text: action.text };
    }
    case 'hover':
      return { type: 'hover', target: requireCachedTarget(target, action.type) };
    case 'press_key':
      assertNoSecretText(action.key, 'press_key.key');
      return { type: 'press_key', key: action.key };
    case 'select_option':
      assertNoSecretText(action.value, 'select_option.value');
      return { type: 'select_option', target: requireCachedTarget(target, action.type), value: action.value };
    case 'reload':
      return { type: 'reload' };
    case 'go_back':
      return { type: 'go_back' };
    case 'wait':
      return { type: 'wait', ms: action.ms };
    case 'assert_dom':
      assertNoSecretText(action.contains, 'assert_dom.contains');
      return { type: 'assert_dom', target: requireCachedTarget(target, action.type), contains: action.contains };
    case 'extract':
      assertNoSecretText(action.key, 'extract.key');
      if (action.pattern) assertNoSecretText(action.pattern, 'extract.pattern');
      return {
        type: 'extract',
        target: requireCachedTarget(target, action.type),
        key: action.key,
        ...(action.pattern && { pattern: action.pattern }),
      };
    // Phase 9/10 parity actions are non-idempotent, stateful, or unsafe to
    // replay from a locator-only record (file paths, tab ids, mouse coords,
    // scripted sequences) — deliberately NOT cached. loop.ts catches this
    // rejection and simply skips caching that step.
    case 'upload_file':
    case 'drag_and_drop':
    case 'blur':
    case 'mouse':
    case 'open_tab':
    case 'switch_tab':
    case 'close_tab':
    case 'script':
    case 'assert_visual':
    // A5's deterministic assertion verbs are READ-ONLY checks, not page
    // mutations — there is no "effect" for verifyActionEffect to confirm, and
    // their value shape (regex/comparator/status-class) does not fit the
    // locator-only CachedActionValue. Re-evaluating them is cheap and exact,
    // so caching would add risk for no saving. Rejected like assert_visual.
    case 'assert_text':
    case 'assert_count':
    case 'assert_url':
    case 'assert_state':
    case 'assert_network':
    case 'assert_no_console_errors':
    case 'finish':
      throw new ActionCacheRejectedError(`${action.type} is not stored in the action cache`);
  }
}

export async function actionFromCachedValue(
  value: CachedActionValue,
  ax: AxSnapshot,
  browser?: Pick<BrowserPort, 'findByQaId'>,
): Promise<Action | null> {
  switch (value.type) {
    case 'navigate':
      return { type: 'navigate', url: value.url };
    case 'click': {
      const nodeId = await resolveCachedTarget(value.target, ax, browser);
      return nodeId ? { type: 'click', nodeId } : null;
    }
    case 'type': {
      const nodeId = await resolveCachedTarget(value.target, ax, browser);
      return nodeId ? { type: 'type', nodeId, text: value.text } : null;
    }
    case 'hover': {
      const nodeId = await resolveCachedTarget(value.target, ax, browser);
      return nodeId ? { type: 'hover', nodeId } : null;
    }
    case 'press_key':
      return { type: 'press_key', key: value.key };
    case 'select_option': {
      const nodeId = await resolveCachedTarget(value.target, ax, browser);
      return nodeId ? { type: 'select_option', nodeId, value: value.value } : null;
    }
    case 'reload':
      return { type: 'reload' };
    case 'go_back':
      return { type: 'go_back' };
    case 'wait':
      return { type: 'wait', ms: value.ms };
    case 'assert_dom': {
      const nodeId = await resolveCachedTarget(value.target, ax, browser);
      return nodeId ? { type: 'assert_dom', nodeId, contains: value.contains } : null;
    }
    case 'extract': {
      const nodeId = await resolveCachedTarget(value.target, ax, browser);
      return nodeId ? { type: 'extract', nodeId, key: value.key, ...(value.pattern && { pattern: value.pattern }) } : null;
    }
  }
}

export async function captureActionEffectState(browser: BrowserPort): Promise<ActionEffectState> {
  const url = await browser.url();
  // peekAxTree, NOT axTree: this is an OBSERVER. axTree() rebinds the planner's
  // n-ids, and the driver captures before-state mid-batch — so re-snapshotting
  // here used to repoint the batch's remaining ids at a newer tree (a click
  // planned as `n8` landed on whatever `n8` meant afterwards). Falls back for
  // ports that don't implement peek.
  const ax = browser.peekAxTree ? await browser.peekAxTree() : await browser.axTree();
  return {
    url,
    normalizedUrl: normalizeUrlForActionCache(url),
    pageSignature: pageSignatureFromAx(ax),
    capturedAt: Date.now(),
    ax,
  };
}

export function verifyActionEffect(
  before: ActionEffectState,
  after: ActionEffectState,
  action: Action,
  target?: StepTarget,
): ActionEffectResult {
  const changes: string[] = [];
  if (before.normalizedUrl !== after.normalizedUrl) changes.push('url');
  if (before.pageSignature !== after.pageSignature) changes.push('page-signature');

  if (action.type === 'wait') {
    const elapsed = after.capturedAt - before.capturedAt;
    if (elapsed >= Math.max(0, action.ms - 25)) {
      return { ok: true, reason: `waited ${elapsed}ms`, changes };
    }
    return { ok: false, reason: `wait expected ${action.ms}ms, observed ${elapsed}ms`, changes };
  }

  // navigate/reload/go_back/press_key keep their pre-A9 semantics: a URL or
  // page-signature diff is sufficient evidence for these (they have no
  // "target" to land on the wrong element, unlike click/hover/type/
  // select_option, so the false-positive risk A9 flags does not apply here).
  if (action.type === 'navigate') {
    const expected = normalizeUrlForActionCache(action.url);
    if (after.normalizedUrl === expected) {
      const errorSignal = detectErrorPageSignal(after.ax.root);
      if (errorSignal) {
        return {
          ok: false,
          reason: `navigation reached the expected URL but the destination looks like an error page ("${errorSignal}")`,
          changes,
        };
      }
      return { ok: true, reason: 'navigation reached the expected URL', changes };
    }
    if (changes.length) return { ok: true, reason: `observed ${changes.join(' and ')} change after navigate`, changes };
    return { ok: false, reason: 'navigate did not reach the expected URL and nothing else observably changed', changes };
  }

  if (action.type === 'reload') {
    if (after.normalizedUrl === before.normalizedUrl) {
      return { ok: true, reason: 'reload settled on the same URL', changes };
    }
    if (changes.length) return { ok: true, reason: `observed ${changes.join(' and ')} change after reload`, changes };
    return { ok: false, reason: 'reload produced no observable URL or page change', changes };
  }

  if (action.type === 'go_back') {
    if (changes.length) return { ok: true, reason: `observed ${changes.join(' and ')} change after go_back`, changes };
    return { ok: false, reason: 'go_back produced no observable URL or page change', changes };
  }

  if (action.type === 'press_key') {
    if (changes.length) return { ok: true, reason: `observed ${changes.join(' and ')} change after press_key`, changes };
    return { ok: false, reason: 'press_key produced no observable URL or page change', changes };
  }

  // click/hover: A9's core fix. A cached target re-resolves by role+name+nth
  // against the live page, so a hit cannot land on an arbitrary node — but it
  // CAN land on a node that still matches role+name+nth while no longer being
  // the same element semantically (a reordered list, a redesign recycling a
  // label). A bare page-signature diff (a toast, an ad refresh, an unrelated
  // ticker) is therefore no longer sufficient on its own: we require the
  // change to be *targeted* — the click/hover's own target changed or
  // disappeared, the URL changed, or a live-region-ish (alert/status/dialog/
  // tooltip) node appeared/changed/disappeared.
  if (action.type === 'click') {
    if (target) {
      const beforeNode = findByCachedTarget(before.ax.root, target);
      const afterNode = findByCachedTarget(after.ax.root, target);
      if (beforeNode && !afterNode) {
        return { ok: true, reason: 'click target was removed or navigated away, a legitimate outcome', changes };
      }
      if (beforeNode && afterNode && targetOwnChangeDetected(beforeNode, afterNode)) {
        return { ok: true, reason: 'click target state/name/value changed', changes };
      }
    }
    if (changes.includes('url')) {
      return { ok: true, reason: 'click navigated to a new URL', changes };
    }
    const regionSignal = regionChangeDetected(before.ax.root, after.ax.root);
    if (regionSignal) {
      return { ok: true, reason: `click produced a targeted effect: ${regionSignal}`, changes };
    }
    return {
      ok: false,
      reason: 'click produced no targeted effect on its own target, the URL, or an alert/status/dialog region (only unrelated page changes, if any)',
      changes,
    };
  }

  if (action.type === 'hover') {
    if (!target) {
      return { ok: false, reason: 'hover cannot be verified without a target descriptor', changes };
    }
    const afterNode = findByCachedTarget(after.ax.root, target);
    if (!afterNode) {
      return { ok: false, reason: 'hover target no longer resolves on the page', changes };
    }
    const beforeNode = findByCachedTarget(before.ax.root, target);
    const ownChanged = beforeNode ? targetOwnChangeDetected(beforeNode, afterNode) : false;
    const regionSignal = regionChangeDetected(before.ax.root, after.ax.root);
    if (ownChanged) {
      return { ok: true, reason: 'hover target state changed', changes };
    }
    if (regionSignal) {
      return { ok: true, reason: `hover revealed a targeted effect: ${regionSignal}`, changes };
    }
    // A signature diff alone is weak evidence for a hover by nature (hover is
    // usually a probe for a tooltip, not a mutation) — reject and let the
    // caller fall back to a fresh navigator call, the safe direction.
    return { ok: false, reason: 'hover produced no observable target state change or tooltip/dialog region', changes };
  }

  if (action.type === 'type' && target) {
    const beforeNode = findByCachedTarget(before.ax.root, target);
    const afterNode = findByCachedTarget(after.ax.root, target);
    if (afterNode && actionTextVerifies(action.text, afterNode, beforeNode)) {
      return { ok: true, reason: 'typed value is visible in the target state', changes };
    }
    return { ok: false, reason: 'typed value was not observed as a change in the target state', changes };
  }

  if (action.type === 'select_option' && target) {
    const node = findByCachedTarget(after.ax.root, target);
    if (node) {
      const wanted = action.value.trim().toLowerCase();
      const exactValue = node.value !== undefined && node.value.trim().toLowerCase() === wanted;
      const exactName = node.name !== undefined && node.name.trim().toLowerCase() === wanted;
      if (exactValue || exactName) {
        return { ok: true, reason: 'selected value exactly matches the target state', changes };
      }
      if (nodeText(node).toLowerCase().includes(wanted)) {
        return {
          ok: true,
          reason: 'selected value substring-matches the target state (no exact value/name match was available)',
          changes,
        };
      }
    }
    return { ok: false, reason: 'selected value was not observed in the target state', changes };
  }

  if (action.type === 'assert_dom') {
    const node = findNode(after.ax.root, action.nodeId) ?? (target ? findByCachedTarget(after.ax.root, target) : undefined);
    const hay = node ? nodeText(node) : '';
    if (hay.toLowerCase().includes(action.contains.toLowerCase())) {
      return { ok: true, reason: 'DOM assertion condition is satisfied', changes };
    }
    return { ok: false, reason: 'DOM assertion condition is not satisfied', changes };
  }

  if (action.type === 'extract') {
    const node =
      (action.nodeId ? findNode(after.ax.root, action.nodeId) : undefined) ??
      (target ? findByCachedTarget(after.ax.root, target) : undefined);
    const text = node ? nodeText(node) : '';
    if (!text) return { ok: false, reason: 'extract target has no visible text', changes };
    if (action.pattern) {
      let re: RegExp;
      try {
        re = new RegExp(action.pattern);
      } catch {
        return { ok: false, reason: 'extract pattern is not a valid regular expression', changes };
      }
      if (!re.test(text)) return { ok: false, reason: 'extract pattern did not match target text', changes };
    }
    return { ok: true, reason: 'extract target text is available', changes };
  }

  return { ok: false, reason: 'no observable URL, DOM, value, wait, or assertion effect', changes };
}

export function assertNoSecretsInCacheRecord(record: ActionCacheRecord): void {
  scanForSecretMaterial(record, '$');
}

export class FileActionCache {
  constructor(readonly rootDir: string) {}

  getPath(key: ActionCacheKey): string {
    return path.join(this.rootDir, `v${ACTION_CACHE_VERSION}`, key.id.slice(0, 2), `${key.id}.json`);
  }

  read(key: ActionCacheKey): ActionCacheRecord | null {
    const file = this.getPath(key);
    if (!fs.existsSync(file)) return null;
    let record: ActionCacheRecord;
    try {
      record = JSON.parse(fs.readFileSync(file, 'utf8')) as ActionCacheRecord;
    } catch {
      return null; // corrupt cache entry — treat as a miss, same as findForContext()
    }
    if (record.version !== ACTION_CACHE_VERSION || record.key.id !== key.id) return null;
    assertNoSecretsInCacheRecord(record);
    return record;
  }

  write(record: ActionCacheRecord): void {
    assertNoSecretsInCacheRecord(record);
    const file = this.getPath(record.key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, file);
  }

  put(key: ActionCacheKey, value: CachedActionValue, metadata?: ActionCacheRecord['metadata']): ActionCacheRecord {
    const existing = this.read(key);
    const record: ActionCacheRecord = {
      version: ACTION_CACHE_VERSION,
      key,
      value,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      hitCount: existing?.hitCount ?? 0,
      lastHitAt: existing?.lastHitAt,
      ...(metadata && { metadata }),
    };
    this.write(record);
    return record;
  }

  markHit(record: ActionCacheRecord): ActionCacheRecord {
    const next: ActionCacheRecord = {
      ...record,
      hitCount: record.hitCount + 1,
      lastHitAt: new Date().toISOString(),
    };
    this.write(next);
    return next;
  }

  delete(key: ActionCacheKey): void {
    fs.rmSync(this.getPath(key), { force: true });
  }

  findForContext(input: { url: string; goal: string; page: AxSnapshot | string }, limit = 5): ActionCacheRecord[] {
    const normalizedUrl = normalizeUrlForActionCache(input.url);
    const normalizedGoal = normalizeGoalForActionCache(input.goal);
    const pageSignature = pageSignatureFromAx(input.page);
    const dir = path.join(this.rootDir, `v${ACTION_CACHE_VERSION}`);
    if (!fs.existsSync(dir)) return [];
    const out: ActionCacheRecord[] = [];
    const stack = [dir];
    while (stack.length && out.length < limit) {
      const current = stack.pop()!;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const p = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(p);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        try {
          const record = JSON.parse(fs.readFileSync(p, 'utf8')) as ActionCacheRecord;
          if (
            record.version === ACTION_CACHE_VERSION &&
            record.key.normalizedUrl === normalizedUrl &&
            record.key.normalizedGoal === normalizedGoal &&
            record.key.pageSignature === pageSignature
          ) {
            assertNoSecretsInCacheRecord(record);
            out.push(record);
            if (out.length >= limit) break;
          }
        } catch {
          /* corrupt cache entries are ignored; navigator fallback handles the run */
        }
      }
    }
    return out.sort((a, b) => (b.lastHitAt ?? b.createdAt).localeCompare(a.lastHitAt ?? a.createdAt));
  }
}

export function integrationHookNotes(): string[] {
  return [
    'Before the navigator call in runDriverLoop, buildActionCacheKey({ url: batchUrl, goal: goals[currentGoal], action: intendedAction, page: ax, target }) only after the driver has a specific action intent; do not key on task text alone.',
    'On a cache hit, call actionFromCachedValue(record.value, ax, browser), captureActionEffectState() before and after executing the rehydrated action, and accept the hit only when verifyActionEffect().ok is true; otherwise delete or ignore the record and fall back to navigateOnce().',
    'After a navigator action succeeds, build the key from the original redacted Action and StepRecord.target, convert with toCachedActionValue(), verifyActionEffect() from before/after snapshots, then FileActionCache.put(); never pass resolved type text to the cache.',
    'Report cache hit/miss/stale counts in a future report metadata field; the slim five-field verdict should remain unchanged.',
  ];
}

function normalizePathname(pathname: string): string {
  const clean = pathname.replace(/\/{2,}/g, '/');
  if (clean === '' || clean === '/') return '/';
  return clean.endsWith('/') ? clean.slice(0, -1) : clean;
}

function actionIntentForKey(action: Action, target?: StepTarget): string {
  const tgt = target ? targetIntent(target) : 'target:none';
  switch (action.type) {
    case 'navigate':
      return `navigate:${normalizeUrlForActionCache(action.url)}`;
    case 'click':
    case 'hover':
      return `${action.type}:${tgt}`;
    case 'type':
      return `type:${tgt}:text=${textForKey(action.text)}`;
    case 'press_key':
      return `press_key:${textForKey(action.key)}`;
    case 'select_option':
      return `select_option:${tgt}:value=${textForKey(action.value)}`;
    case 'reload':
    case 'go_back':
      return action.type;
    case 'wait':
      return `wait:${action.ms}`;
    case 'assert_dom':
      return `assert_dom:${tgt}:contains=${textForKey(action.contains)}`;
    case 'extract':
      return `extract:${tgt}:key=${textForKey(action.key)}:pattern=${textForKey(action.pattern ?? '')}`;
    case 'assert_visual':
      return `assert_visual:${textForKey(action.expectation)}`;
    case 'upload_file':
      return `upload_file:${tgt}:n=${action.paths.length}`;
    case 'drag_and_drop':
      return `drag_and_drop:${action.sourceId}->${action.targetId}`;
    case 'blur':
      return `blur:${tgt}`;
    case 'mouse':
      return `mouse:${action.kind}:${action.x},${action.y}`;
    case 'open_tab':
      return `open_tab:${normalizeUrlForActionCache(action.url)}`;
    case 'switch_tab':
      return `switch_tab:${action.tabId}`;
    case 'close_tab':
      return `close_tab:${action.tabId}`;
    case 'script':
      return `script:steps=${action.steps.length}`;
    case 'assert_text':
      return `assert_text:${tgt}:${action.mode}=${textForKey(action.value)}`;
    case 'assert_count':
      return `assert_count:role=${action.role}:name=${textForKey(action.name ?? '')}:${action.comparator}=${action.expected}`;
    case 'assert_url':
      return `assert_url:${action.mode}=${textForKey(action.value)}`;
    case 'assert_state':
      return `assert_state:${tgt}:${action.state}`;
    case 'assert_network':
      return `assert_network:${textForKey(action.urlPattern)}:status=${action.status ?? ''}:class=${action.statusClass ?? ''}:absent=${action.absent ?? false}`;
    case 'assert_no_console_errors':
      return `assert_no_console_errors:allow=${(action.allow ?? []).map(textForKey).join(',')}`;
    case 'finish':
      return `finish:${action.verdict}:${textForKey(action.reason)}`;
  }
}

function targetIntent(target: StepTarget | CachedTarget): string {
  return [
    `role=${target.role.toLowerCase()}`,
    `name=${textForKey(target.name ?? '')}`,
    `nth=${target.nth ?? 0}`,
    `qaId=${target.qaId ? sha256(target.qaId).slice(0, 12) : ''}`,
  ].join('|');
}

function textForKey(text: string): string {
  return redactSecretLikeText(text)
    .replace(SECRET_PLACEHOLDER_RE, '{{secret:*}}')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, 240);
}

function requireCachedTarget(target: StepTarget | undefined, actionType: string): CachedTarget {
  if (!target) throw new ActionCacheRejectedError(`${actionType} cannot be cached without StepRecord.target`);
  assertNoSecretText(target.role, 'target.role');
  if (target.name) assertNoSecretText(target.name, 'target.name');
  if (target.qaId) assertNoSecretText(target.qaId, 'target.qaId');
  return {
    role: target.role,
    ...(target.name && { name: target.name }),
    ...(target.nth !== undefined && { nth: target.nth }),
    ...(target.qaId && { qaId: target.qaId }),
  };
}

function assertTypeTextCanBeCached(text: string, target: CachedTarget): void {
  if (hasSecretPlaceholder(text)) {
    return;
  }
  const targetText = `${target.role} ${target.name ?? ''}`;
  if (CREDENTIAL_TARGET_RE.test(targetText)) {
    throw new ActionCacheRejectedError('type action for a credential-like target must use a {{secret:NAME}} placeholder');
  }
  assertNoSecretText(text, 'type.text');
}

function assertNoSecretText(text: string, field: string): void {
  if (looksSecretLike(text)) throw new ActionCacheRejectedError(`${field} looks like secret material`);
}

function looksSecretLike(text: string): boolean {
  const withoutPlaceholders = text.replace(SECRET_PLACEHOLDER_RE, '{{secret:*}}');
  if (SECRET_PATTERNS.some((re) => re.test(withoutPlaceholders))) return true;
  const compact = withoutPlaceholders.replace(/\s+/g, '');
  const structuredMetadata = /[=:|]/.test(withoutPlaceholders);
  if (
    !structuredMetadata &&
    compact.length >= 28 &&
    /[a-z]/.test(compact) &&
    /[A-Z]/.test(compact) &&
    /\d/.test(compact) &&
    /[^A-Za-z0-9]/.test(compact)
  ) {
    return true;
  }
  return false;
}

function redactSecretLikeText(text: string): string {
  let out = text.replace(SECRET_PLACEHOLDER_RE, '{{secret:*}}');
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

function scanForSecretMaterial(value: unknown, pathName: string): void {
  if (typeof value === 'string') {
    if (looksSecretLike(value)) throw new ActionCacheRejectedError(`${pathName} looks like secret material`);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanForSecretMaterial(v, `${pathName}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value)) scanForSecretMaterial(v, `${pathName}.${k}`);
}

function stableAxMaterial(root: AxNode): string {
  const lines: string[] = [];
  const walk = (node: AxNode, depth: number) => {
    if (lines.length >= 250) return;
    const parts = [String(depth), node.role];
    if (node.name) parts.push(node.name);
    if (node.value) parts.push(redactSecretLikeText(node.value));
    if (node.states?.length) parts.push(node.states.join(','));
    lines.push(parts.join('|'));
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  walk(root, 0);
  return lines.join('\n');
}

async function resolveCachedTarget(
  target: CachedTarget,
  ax: AxSnapshot,
  browser?: Pick<BrowserPort, 'findByQaId'>,
): Promise<string | null> {
  if (target.qaId && browser?.findByQaId) {
    const byQaId = await browser.findByQaId(target.qaId);
    if (byQaId) return byQaId;
  }
  return findByCachedTarget(ax.root, target)?.id ?? null;
}

function findByCachedTarget(root: AxNode, target: CachedTarget): AxNode | undefined {
  const matches: AxNode[] = [];
  const walk = (node: AxNode) => {
    if (node.role === target.role && node.name === target.name) matches.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return pickClearCacheWinner(matches, target);
}

/** A21 (P1): port of recorder/replay.ts's `pickClearRoleWinner` collision
 * discipline into the action cache — `matches[target.nth ?? 0]` used to pick
 * index 0 silently whenever a page grew a second same-role+name element after
 * the entry was cached (audit A21). `CachedTarget` carries no landmark/
 * siblingText disambiguation hints the way `replay.ts`'s scored candidates
 * do (only role/name/nth/qaId — see `CachedTarget`), so unlike the full
 * scored version, an explicit `nth` is the ONLY signal available here: with
 * one, pick that index (matching pre-A21 behavior when nth was recorded);
 * with none and more than one match, it is an unbreakable tie — return
 * `undefined` (a miss) rather than guess, exactly as `pickClearRoleWinner`
 * returns null on a tie. */
function pickClearCacheWinner(matches: AxNode[], target: CachedTarget): AxNode | undefined {
  if (matches.length === 0) return undefined;
  if (typeof target.nth === 'number') return matches[target.nth];
  if (matches.length === 1) return matches[0];
  return undefined; // ambiguous role+name, no nth to disambiguate — cache miss, not matches[0]
}

function findNode(root: AxNode, id: string): AxNode | undefined {
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return undefined;
}

function nodeText(node: AxNode): string {
  const parts: string[] = [];
  const walk = (n: AxNode) => {
    if (n.name) parts.push(n.name);
    if (n.value) parts.push(n.value);
    for (const child of n.children ?? []) walk(child);
  };
  walk(node);
  return parts.join(' ');
}

function actionTextVerifies(text: string, node: AxNode, beforeNode?: AxNode): boolean {
  if (hasSecretPlaceholder(text)) {
    if (!(node.value || node.states?.includes('focused'))) return false;
    // A9: "non-empty or focused" alone lets an already-focused, already-
    // populated field pass with no actual value change. Require the field to
    // have been previously empty or to differ from its prior value; when
    // there is no prior node to compare against, keep the permissive read
    // (we cannot prove staleness either way).
    if (!beforeNode) return true;
    const beforeValue = beforeNode.value ?? '';
    const afterValue = node.value ?? '';
    return beforeValue.length === 0 || beforeValue !== afterValue;
  }
  return nodeText(node).toLowerCase().includes(text.toLowerCase());
}

/** role+name/value/states diff on the SAME resolved target — the strongest
 * A9 evidence: proves the click/hover landed on and affected its own node,
 * independent of anything else on the page. */
function targetOwnChangeDetected(beforeNode: AxNode, afterNode: AxNode): boolean {
  if ((beforeNode.name ?? '') !== (afterNode.name ?? '')) return true;
  if ((beforeNode.value ?? '') !== (afterNode.value ?? '')) return true;
  const beforeStates = (beforeNode.states ?? []).slice().sort().join(',');
  const afterStates = (afterNode.states ?? []).slice().sort().join(',');
  return beforeStates !== afterStates;
}

/** Roles a click/hover can legitimately surface as a targeted side-effect
 * (a toast, a validation message, a newly-revealed tooltip, a dialog opening)
 * — distinct from the general page-signature diff, which also fires for
 * wholly unrelated mutations (an ad refresh, a live ticker) that A9 says must
 * NOT be accepted as proof an action worked. */
const SIGNAL_REGION_ROLES = new Set(['alert', 'alertdialog', 'dialog', 'status', 'log', 'tooltip']);

function collectSignalRegions(root: AxNode): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (node: AxNode) => {
    if (SIGNAL_REGION_ROLES.has(node.role)) {
      map.set(`${node.role}|${node.name ?? ''}`, nodeText(node));
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return map;
}

function regionChangeDetected(beforeRoot: AxNode, afterRoot: AxNode): string | null {
  const beforeMap = collectSignalRegions(beforeRoot);
  const afterMap = collectSignalRegions(afterRoot);
  for (const [key, text] of afterMap) {
    const role = key.split('|', 1)[0];
    const prior = beforeMap.get(key);
    if (prior === undefined) return `a new ${role} region appeared`;
    if (prior !== text) return `the ${role} region's content changed`;
  }
  for (const key of beforeMap.keys()) {
    if (!afterMap.has(key)) return `a ${key.split('|', 1)[0]} region disappeared`;
  }
  return null;
}

const ERROR_PAGE_PATTERNS = [
  /\b(404|500|502|503|504)\b/,
  /page not found/i,
  /something went wrong/i,
  /internal server error/i,
  /application error/i,
  /an unexpected error occurred/i,
  /service unavailable/i,
];

/** Cheap, AX-snapshot-only heuristic for A9's "500 page at the right URL"
 * gap: navigate only verified the destination URL, so an error page served
 * at the expected route still counted as verified. No new I/O — reuses the
 * `after` snapshot already captured for the URL/signature diff. */
function detectErrorPageSignal(root: AxNode): string | null {
  let found: string | null = null;
  const walk = (node: AxNode) => {
    if (found) return;
    if (node.role === 'heading' || node.role === 'alert' || node.role === 'alertdialog' || node.role === 'status') {
      const text = nodeText(node);
      if (ERROR_PAGE_PATTERNS.some((re) => re.test(text))) {
        found = text.slice(0, 80);
        return;
      }
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return found;
}

function hasSecretPlaceholder(text: string): boolean {
  SECRET_PLACEHOLDER_RE.lastIndex = 0;
  const found = SECRET_PLACEHOLDER_RE.test(text);
  SECRET_PLACEHOLDER_RE.lastIndex = 0;
  return found;
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}
