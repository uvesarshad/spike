/* Lightweight HTML structural extraction for the discovery crawler (A23).
 *
 * The crawler (`crawler.ts`) never drives a real browser — it takes an
 * injected fetch-or-navigate function returning raw markup (see the crawler's
 * header comment / the task's constraint: no engine.ts, no driver/loop.ts, no
 * port; browser-agnostic). So there is no real `Accessibility.getFullAXTree`
 * here — this module does a deliberately crude, regex-based tag walk that is
 * "good enough" to (a) find same-origin links, (b) list interactive elements
 * for the coverage ledger, and (c) produce `depth|role` pairs comparable with
 * `signature.ts`'s structural signature for a real AX tree. It is not, and
 * does not try to be, a spec-compliant HTML parser — canned test fixtures and
 * typical server-rendered markup are the target, not adversarial HTML.
 *
 * Depth accounting: EVERY non-void tag (including generic `div`/`span`
 * wrappers) pushes/pops the nesting stack so a recorded element's depth
 * reflects real DOM nesting — a modal wrapped in extra `<div>`s is a
 * genuinely different depth, not a parser artifact. Only tags with a role
 * mapping are actually recorded as depth/role pairs; wrappers only move the
 * depth counter. */

import { collectDepthRolePairs, signatureFromPairs, type StructuralNode } from './signature.js';

export interface InteractiveElement {
  role: string;
  name?: string;
}

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const TAG_ROLE_MAP: Record<string, string> = {
  a: 'link',
  button: 'button',
  form: 'form',
  nav: 'navigation',
  main: 'main',
  header: 'banner',
  footer: 'contentinfo',
  dialog: 'dialog',
  select: 'combobox',
  textarea: 'textbox',
  ul: 'list',
  ol: 'list',
  li: 'listitem',
  table: 'table',
  tr: 'row',
  td: 'cell',
  th: 'columnheader',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  img: 'img',
  section: 'region',
  article: 'article',
};

/** Roles the coverage ledger treats as "interactive" (a user can act on
 * them) — the subset that matters for "elements discovered vs touched". */
const INTERACTIVE_ROLES = new Set(['link', 'button', 'checkbox', 'radio', 'combobox', 'textbox']);

const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)\/?>/g;

interface TagToken {
  tag: string;
  attrs: string;
  closing: boolean;
  selfClose: boolean;
  raw: string;
  index: number;
}

function stripNonContentBlocks(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
}

function tokenize(html: string): TagToken[] {
  const clean = stripNonContentBlocks(html);
  const tokens: TagToken[] = [];
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(clean))) {
    const raw = m[0];
    const tag = m[1].toLowerCase();
    tokens.push({
      tag,
      attrs: m[2] ?? '',
      closing: raw.startsWith('</'),
      selfClose: raw.endsWith('/>') || VOID_TAGS.has(tag),
      raw,
      index: m.index,
    });
  }
  return tokens;
}

function attr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i');
  const m = re.exec(attrs);
  if (!m) return undefined;
  return (m[2] ?? m[3] ?? '').trim();
}

function roleForTag(tag: string, attrs: string): string | null {
  const explicit = attr(attrs, 'role');
  if (explicit) return explicit.toLowerCase();
  if (tag === 'input') {
    const type = (attr(attrs, 'type') ?? 'text').toLowerCase();
    if (type === 'hidden') return null;
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
    return 'textbox';
  }
  return TAG_ROLE_MAP[tag] ?? null;
}

function nameForElement(attrs: string, innerText: string): string | undefined {
  const label = attr(attrs, 'aria-label') ?? attr(attrs, 'placeholder') ?? attr(attrs, 'title');
  if (label) return label;
  const text = innerText.trim().replace(/\s+/g, ' ');
  if (text) return text.slice(0, 120);
  const name = attr(attrs, 'name') ?? attr(attrs, 'id') ?? attr(attrs, 'value');
  return name || undefined;
}

/** `depth|role` pairs from raw markup — fed straight into `signature.ts`'s
 * `signatureFromPairs` so HTML-derived and real-AX-tree signatures are
 * produced by the identical hashing step. */
export function collectHtmlDepthRolePairs(html: string): Array<[number, string]> {
  const tokens = tokenize(html);
  const stack: string[] = [];
  const pairs: Array<[number, string]> = [];
  for (const t of tokens) {
    if (t.closing) {
      // Pop back to (and including) the matching tag if present; tolerate
      // unbalanced/garbled markup by scanning for the nearest match rather
      // than assuming perfectly nested input.
      const idx = stack.lastIndexOf(t.tag);
      if (idx !== -1) stack.length = idx;
      continue;
    }
    const depth = stack.length;
    const role = roleForTag(t.tag, t.attrs);
    if (role) pairs.push([depth, role]);
    if (!t.selfClose) stack.push(t.tag);
  }
  return pairs;
}

export function structuralSignatureFromHtml(html: string): string {
  return signatureFromPairs(collectHtmlDepthRolePairs(html));
}

/** Builds an actual nested `StructuralNode` tree from markup — used only
 * where a real tree (not just the flat pair list) is useful, e.g. tests that
 * want to exercise `signature.ts`'s tree-walking path against HTML-shaped
 * input. Not used by the crawler itself (`collectHtmlDepthRolePairs` is
 * cheaper and sufficient there). */
export function htmlToStructuralNode(html: string): StructuralNode {
  const tokens = tokenize(html);
  const root: StructuralNode = { role: 'root', children: [] };
  const stack: StructuralNode[] = [root];
  for (const t of tokens) {
    if (t.closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const role = roleForTag(t.tag, t.attrs) ?? 'generic';
    const node: StructuralNode = { role, children: [] };
    stack[stack.length - 1].children!.push(node);
    if (!t.selfClose) stack.push(node);
  }
  return root;
}

/** Absolute same-document links extracted from `<a href>`. Relative hrefs are
 * resolved against `baseUrl`; unparseable/`javascript:`/`mailto:`/`tel:`/`#`
 * fragment-only hrefs are dropped. Caller is responsible for same-origin
 * filtering (the crawler does this so the guard lives in one place). */
export function extractLinks(html: string, baseUrl: string): string[] {
  const tokens = tokenize(html);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (t.closing || t.tag !== 'a') continue;
    const href = attr(t.attrs, 'href');
    if (!href) continue;
    const trimmed = href.trim();
    if (!trimmed || trimmed.startsWith('#') || /^(javascript|mailto|tel):/i.test(trimmed)) continue;
    let resolved: string;
    try {
      resolved = new URL(trimmed, baseUrl).toString();
    } catch {
      continue;
    }
    if (!seen.has(resolved)) {
      seen.add(resolved);
      out.push(resolved);
    }
  }
  return out;
}

/** Interactive elements on the page — deduplicated by role+name — for the
 * coverage ledger's "interactive elements discovered" side. Best-effort inner
 * text extraction for `<a>`/`<button>` uses a simple non-nested scan (find
 * the next same-tag close after the open tag); good enough for typical
 * markup, not a general HTML parser. */
export function extractInteractiveElements(html: string): InteractiveElement[] {
  const clean = stripNonContentBlocks(html);
  const tokens = tokenize(html);
  const out: InteractiveElement[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (t.closing) continue;
    const role = roleForTag(t.tag, t.attrs);
    if (!role || !INTERACTIVE_ROLES.has(role)) continue;
    let innerText = '';
    if (!t.selfClose) {
      const closeTag = `</${t.tag}`;
      const closeIdx = clean.toLowerCase().indexOf(closeTag.toLowerCase(), t.index + t.raw.length);
      if (closeIdx !== -1) {
        innerText = clean
          .slice(t.index + t.raw.length, closeIdx)
          .replace(/<[^>]+>/g, ' ');
      }
    }
    const name = nameForElement(t.attrs, innerText);
    const key = `${role}|${(name ?? '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ role, ...(name && { name }) });
  }
  return out;
}
