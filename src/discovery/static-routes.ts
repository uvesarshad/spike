/* Static route extraction — the cheapest, first layer of A23's discovery
 * ladder (docs/plan/26-08-08-options-autonomy-layer.md, A23 "Discovery
 * mechanism" table: static extraction is free/instant, reaches only declared
 * routes). Three independent sources, all pure functions with no fs/network
 * of their own — callers (the daemon has filesystem access; `discover.ts`
 * has the injected fetcher) supply the raw text/listing:
 *
 *   1. `parseSitemapXml` / `parseRobotsTxt` — a fetched `sitemap.xml` or
 *      `robots.txt` (the caller fetches these via the same injected
 *      fetch-or-navigate function the crawler uses, so this module never
 *      touches the network itself).
 *   2. `routesFromFileList` — a Next.js `app/` (App Router) or `pages/`
 *      (Pages Router) file listing, already collected by the caller (real
 *      `fs.readdirSync` walk in production, a canned array in tests) —
 *      kept as a pure string-array function specifically so it needs no real
 *      filesystem to test. */

export type RouterKind = 'app' | 'pages';

const PAGE_FILENAMES = new Set(['page.tsx', 'page.jsx', 'page.ts', 'page.js', 'page.mdx']);
const PAGES_IGNORE_BASENAMES = new Set(['_app', '_document', '_error', '404', '500']);

/** `<loc>...</loc>` entries from a sitemap XML document, trimmed and with the
 * handful of XML entities sitemaps commonly carry decoded. Not a real XML
 * parser (this repo has no XML dependency) — sitemaps are simple enough that
 * a targeted regex is reliable and avoids a new dependency. */
export function parseSitemapXml(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    out.push(decodeXmlEntities(m[1]));
  }
  return out;
}

/** `Sitemap: <url>` directives from a robots.txt body (case-insensitive
 * per the spec; one per line). */
export function parseRobotsTxt(text: string): { sitemapUrls: string[] } {
  const sitemapUrls: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*sitemap\s*:\s*(\S+)\s*$/i.exec(line);
    if (m) sitemapUrls.push(m[1]);
  }
  return { sitemapUrls };
}

/** A single dynamic-segment token: `[id]` -> `:id`, `[...slug]`/`[[...slug]]`
 * -> `*` (catch-all — the exact captured segments don't matter for a route
 * pattern), a `(group)` route-group folder -> dropped entirely (Next.js App
 * Router groups do not appear in the URL). Returns `null` to mean "drop this
 * segment". */
function segmentToRouteToken(seg: string): string | null {
  if (seg.startsWith('(') && seg.endsWith(')')) return null;
  if (/^\[\[\.\.\..+\]\]$/.test(seg)) return '*';
  if (/^\[\.\.\..+\]$/.test(seg)) return '*';
  if (seg.startsWith('[') && seg.endsWith(']')) return `:${seg.slice(1, -1)}`;
  return seg;
}

function joinRoute(tokens: string[]): string {
  const route = `/${tokens.join('/')}`;
  return route.replace(/\/{2,}/g, '/');
}

function stripExtension(filename: string): string {
  return filename.replace(/\.(tsx|jsx|ts|js|mdx)$/i, '');
}

/** `files`: relative paths (forward or back slashes both accepted) rooted at
 * (but optionally including) the `app/`/`pages/` directory itself, e.g.
 * `"app/products/[id]/page.tsx"` or just `"products/[id]/page.tsx"`. Returns
 * deduplicated, sorted route patterns (`/products/:id`). */
export function routesFromFileList(files: string[], kind: RouterKind): string[] {
  const routes = new Set<string>();
  for (const raw of files) {
    const normalized = raw.replace(/\\/g, '/').replace(/^\.\//, '');
    const parts = normalized.split('/').filter(Boolean);
    if (kind === 'app') {
      const route = appRouteFromParts(parts);
      if (route !== null) routes.add(route);
    } else {
      const route = pagesRouteFromParts(parts);
      if (route !== null) routes.add(route);
    }
  }
  return [...routes].sort();
}

function dropRootSegment(parts: string[], root: 'app' | 'pages'): string[] {
  return parts[0] === root ? parts.slice(1) : parts;
}

function appRouteFromParts(parts: string[]): string | null {
  const filename = parts[parts.length - 1];
  if (!PAGE_FILENAMES.has(filename.toLowerCase())) return null;
  const dirParts = dropRootSegment(parts.slice(0, -1), 'app');
  const tokens = dirParts.map(segmentToRouteToken).filter((t): t is string => t !== null);
  return tokens.length ? joinRoute(tokens) : '/';
}

function pagesRouteFromParts(parts: string[]): string | null {
  const dirParts = dropRootSegment(parts, 'pages');
  if (dirParts.length === 0) return null;
  if (dirParts[0] === 'api') return null; // API routes are not UI surface
  const filename = dirParts[dirParts.length - 1];
  const basename = stripExtension(filename);
  if (PAGES_IGNORE_BASENAMES.has(basename)) return null;
  const segs = [...dirParts.slice(0, -1), basename];
  const withoutIndex = segs[segs.length - 1] === 'index' ? segs.slice(0, -1) : segs;
  const tokens = withoutIndex.map(segmentToRouteToken).filter((t): t is string => t !== null);
  return tokens.length ? joinRoute(tokens) : '/';
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Route paths declared inside a JavaScript bundle (A24).
 *
 * A client-rendered app ships its whole route table in JS: `{ path: '/cart' }`
 * (React Router / Vue Router), `route: "/checkout"` (a hand-rolled table), and
 * so on. None of it appears in the served markup, so sitemap/robots/Next.js
 * source extraction plus link-following together yield exactly one route for
 * such a site. This is the fourth source, run alongside the Next.js file-list
 * parser rather than instead of it.
 *
 * Deliberately a single regex over the bundle text: a bundle is minified,
 * megabytes long, and not worth parsing. That trades precision for reach, so
 * the output is filtered hard afterwards — a false route costs a wasted page
 * visit, and anything that survives the filter at least LOOKS like a path.
 * Values built at runtime (`path: "/" + slug`) are unreachable by any means
 * short of executing the bundle, and are simply missed. */
export function routesFromBundle(js: string): string[] {
  const routes = new Set<string>();
  const re = /(?:path|route)\s*[:=]\s*['"](\/[^'"]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(js))) {
    const candidate = m[1];
    if (!isPlausibleRoutePath(candidate)) continue;
    routes.add(normalizeBundleRoute(candidate));
  }
  return [...routes].sort();
}

/** Filters the regex's raw catch down to things that could really be a UI
 * route. Rejects: whitespace/template-literal fragments, protocol-relative
 * URLs (`//cdn…`), asset and API paths (a route table and a fetch URL are
 * both `path: '/…'`), and anything implausibly long. */
function isPlausibleRoutePath(p: string): boolean {
  if (p.length > 120) return false;
  if (/\s|\$\{|\\/.test(p)) return false;
  if (p.startsWith('//')) return false;
  if (/^\/(api|_next|static|assets?|dist|node_modules)(\/|$)/i.test(p)) return false;
  if (/\.(js|mjs|cjs|css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|json|xml|txt)$/i.test(p)) return false;
  return true;
}

/** Normalizes a bundle route to the same `:param` shape the rest of the
 * discovery layer speaks: React Router's `:id` already matches, and its
 * `*`/`:id?` splat forms collapse onto it too, so a bundle-declared route and
 * a crawl-discovered one for the same page compare equal. */
function normalizeBundleRoute(p: string): string {
  const trimmed = p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
  return trimmed.replace(/:[^/?]+\??/g, ':param').replace(/\*/g, ':param') || '/';
}
