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
