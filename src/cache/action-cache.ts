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
  const ax = await browser.axTree();
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

  if (action.type === 'navigate') {
    const expected = normalizeUrlForActionCache(action.url);
    if (after.normalizedUrl === expected) {
      return { ok: true, reason: 'navigation reached the expected URL', changes };
    }
  }

  if (action.type === 'reload' && after.normalizedUrl === before.normalizedUrl) {
    return { ok: true, reason: 'reload settled on the same URL', changes };
  }

  if (action.type === 'type' && target) {
    const node = findByCachedTarget(after.ax.root, target);
    if (node && actionTextVerifies(action.text, node)) {
      return { ok: true, reason: 'typed value is visible in the target state', changes };
    }
  }

  if (action.type === 'select_option' && target) {
    const node = findByCachedTarget(after.ax.root, target);
    if (node && nodeText(node).toLowerCase().includes(action.value.toLowerCase())) {
      return { ok: true, reason: 'selected value is visible in the target state', changes };
    }
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

  if (changes.length) return { ok: true, reason: `observed ${changes.join(' and ')} change`, changes };
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
  return matches[target.nth ?? 0];
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

function actionTextVerifies(text: string, node: AxNode): boolean {
  if (hasSecretPlaceholder(text)) {
    return Boolean(node.value || node.states?.includes('focused'));
  }
  return nodeText(node).toLowerCase().includes(text.toLowerCase());
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
