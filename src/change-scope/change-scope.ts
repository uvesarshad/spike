/* E7 — change-scoped runs: turn "what changed in git" into "which pages are
 * affected", so `spike watch --changed` and `spike ci --changed-since <ref>`
 * skip work that cannot matter. Pure except for the injected git runner, so
 * tests never touch a real repository.
 *
 * Deliberately conservative: only file layouts we can read as pages (Next.js
 * `app/` and `pages/`) narrow the scope. Shared code (components, styles,
 * config, dependencies) widens it to everything, and only docs/tests/CI files
 * let a run be skipped outright. A wrong "skip" hides a bug; a wrong "all"
 * only costs a full run. */

import { execFileSync } from 'node:child_process';
import { routesFromFileList } from '../discovery/static-routes.js';

/** Runs `git <args>` in the repo and returns stdout; throws on failure. */
export type GitRunner = (args: string[]) => string;

export class ChangeScopeError extends Error {}

export interface ChangeScope {
  /** Route patterns (`/products/:id`, or `/blog/**` = this page and everything below). Empty when `all` or `skip`. */
  routes: string[];
  /** Something shared changed: run everything. */
  all: boolean;
  /** Only files that cannot change what a page does or looks like changed. */
  skip: boolean;
  /** One plain-English line for the log / summary. */
  reason: string;
  files: string[];
}

/** Files changed against `base` (a branch, tag or commit) plus anything not yet
 * committed. With no base: just the uncommitted work. */
export function changedFiles(git: GitRunner, base?: string): string[] {
  const out = new Set<string>();
  const add = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).forEach((f) => out.add(f.replace(/\\/g, '/')));
  try {
    if (base) {
      if (!/^[\w./@^~-]+$/.test(base) || base.startsWith('-')) throw new ChangeScopeError(`"${base}" is not a branch, tag or commit name.`);
      add(git(['diff', '--name-only', `${base}...HEAD`]));
    }
    add(git(['diff', '--name-only', 'HEAD']));
    add(git(['ls-files', '--others', '--exclude-standard']));
  } catch (e) {
    if (e instanceof ChangeScopeError) throw e;
    throw new ChangeScopeError(`Could not read what changed from git: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }
  return [...out].sort();
}

const IGNORABLE = [
  /(^|\/)(docs?|\.github|\.vscode|\.husky)\//,
  /(^|\/)(tests?|__tests__|e2e|cypress|playwright)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /\.mdx?$/i,
  /(^|\/)(LICENSE|CHANGELOG|\.gitignore|\.editorconfig|\.prettierrc[^/]*|\.eslintrc[^/]*)$/,
];
// .mdx can be a page under app/ or pages/; those are checked before IGNORABLE.
const PAGE_EXT = /\.(tsx|jsx|ts|js|mdx)$/i;

function rootIndex(parts: string[]): { kind: 'app' | 'pages'; at: number } | null {
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === 'app' || parts[i] === 'pages') return { kind: parts[i] as 'app' | 'pages', at: i };
  }
  return null;
}

export function scopeFromFiles(files: string[]): ChangeScope {
  const routes = new Set<string>();
  let all = false;
  let allBecause = '';
  let relevant = 0;
  for (const raw of files) {
    const f = raw.replace(/\\/g, '/').replace(/^\.\//, '');
    const parts = f.split('/');
    const root = rootIndex(parts);
    if (root && PAGE_EXT.test(f)) {
      relevant++;
      const inRoot = parts.slice(root.at); // starts at app/ or pages/
      const name = parts[parts.length - 1];
      if (root.kind === 'pages') {
        if (inRoot[1] === 'api') { all = true; allBecause ||= f; continue; }
        if (/^_(app|document)\./.test(name)) { all = true; allBecause ||= f; continue; }
        for (const r of routesFromFileList([inRoot.join('/')], 'pages')) routes.add(r);
        continue;
      }
      // app router: page.* is one route; layout/loading/colocated files affect that folder and below
      const dir = inRoot.slice(0, -1);
      const [pageRoute] = routesFromFileList([[...dir, 'page.tsx'].join('/')], 'app');
      if (/^page\./.test(name)) { routes.add(pageRoute); continue; }
      if (pageRoute === '/') { all = true; allBecause ||= f; continue; }
      routes.add(`${pageRoute}/**`);
      continue;
    }
    if (IGNORABLE.some((re) => re.test(f))) continue;
    relevant++;
    all = true;
    allBecause ||= f;
  }
  const sorted = [...routes].sort();
  if (all) return { routes: [], all: true, skip: false, reason: `${allBecause} is shared, so every page could be affected.`, files };
  if (!relevant) return { routes: [], all: false, skip: true, reason: files.length ? 'Only docs, tests or settings for tooling changed.' : 'Nothing has changed.', files };
  return { routes: sorted, all: false, skip: false, reason: `Changed pages: ${sorted.join(', ')}.`, files };
}

/** Does this pattern (`/a/:id`, `/a/**`, `/a`) cover the address path? */
export function routeMatches(pattern: string, pathname: string): boolean {
  const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p) || '/';
  const target = norm(pathname);
  if (pattern.endsWith('/**')) {
    const base = norm(pattern.slice(0, -3) || '/');
    return base === '/' || target === base || target.startsWith(`${base}/`);
  }
  const re = new RegExp(`^${norm(pattern).split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.+^${}()|[\]\\*?]/g, '\\$&'))).join('/')}$`);
  return re.test(target);
}

export const anyRouteMatches = (patterns: string[], pathname: string): boolean => patterns.some((p) => routeMatches(p, pathname));

/** Convenience: git → scope. */
export function computeChangeScope(git: GitRunner, base?: string): ChangeScope {
  return scopeFromFiles(changedFiles(git, base));
}

/** Real git runner (the CLI only; tests inject a stub). */
export function realGit(cwd: string = process.cwd()): GitRunner {
  return (args) => {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  };
}
