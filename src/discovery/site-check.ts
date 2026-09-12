/* A24 (second half) — "Check this site": the zero-input level.
 *
 * Every other way in asks the user to say what to test. This one asks nothing:
 * it walks the site, then looks at each page it found, and answers the only
 * question a person actually has the first time — "is any of this broken?"
 *
 * This module holds only the parts the command line and the panel must agree
 * on: which of the mapped pages are worth visiting, the words each visit is
 * asked to check, and how the result is put into a sentence. The running
 * itself belongs to the fan-out orchestrator (`src/orchestrator/fan-out.ts`),
 * which already turns a list of units into budgeted runs and one verdict —
 * this deliberately does not rebuild any of that. */

import type { AppModel } from './app-model.js';

/** How many pages one check visits by default when the desktop helper is
 * driving. The fan-out has its own hard ceiling above this; this is the point
 * where a check stops being something you wait for. */
export const DEFAULT_CHECK_PAGES = 20;

/** The ceiling when there is no desktop helper. A check runs entirely inside
 * the browser then, with no place to park a long job, so it stays short and
 * says why. */
export const LITE_CHECK_PAGES = 10;

/** Shown verbatim whenever the shorter cap applied. */
export const LITE_CAP_NOTE = `Without the optional desktop helper a check looks at up to ${LITE_CHECK_PAGES} pages. Install it to check the whole site at once.`;

export interface CheckTarget {
  /** Full address to open. */
  url: string;
  /** What to call it in the result list — the path, which reads better than a
   * full address in a narrow panel. */
  name: string;
}

/** Absolute, visitable addresses from a map, in the order they should be
 * checked: the entry page first (it is the one a person lands on), then the
 * rest by shortest path, so top-level pages are checked before deep ones when
 * the cap bites.
 *
 * Statically-declared routes that are bare patterns (`/products/:param`) are
 * skipped — there is no single address to open — and so is anything that is
 * not same-site. */
export function checkTargets(model: AppModel, baseUrl: string, max = DEFAULT_CHECK_PAGES): CheckTarget[] {
  let origin: string;
  let entryPath: string;
  try {
    const seed = new URL(baseUrl);
    origin = seed.origin;
    entryPath = seed.pathname || '/';
  } catch {
    return [];
  }

  const byUrl = new Map<string, CheckTarget>();
  for (const route of model.routes) {
    const address = resolveRoute(route.route, origin);
    if (!address) continue;
    if (byUrl.has(address.url)) continue;
    byUrl.set(address.url, address);
  }

  const all = [...byUrl.values()].sort((a, b) => {
    const aEntry = a.name === entryPath ? 0 : 1;
    const bEntry = b.name === entryPath ? 0 : 1;
    if (aEntry !== bEntry) return aEntry - bEntry;
    const depth = segments(a.name) - segments(b.name);
    if (depth !== 0) return depth;
    return a.name.localeCompare(b.name);
  });
  return all.slice(0, Math.max(1, max));
}

function segments(pathname: string): number {
  return pathname.split('/').filter(Boolean).length;
}

/** A ledger route is either a concrete address the crawl reached or a bare
 * pattern from static extraction. Only the first, plus a pattern with no
 * placeholder in it, can actually be opened. */
function resolveRoute(route: string, origin: string): CheckTarget | null {
  if (route.includes(':') && !route.includes('://')) return null; // /products/:param
  if (route.includes('*')) return null;
  let u: URL;
  try {
    u = new URL(route, origin);
  } catch {
    return null;
  }
  if (u.origin !== origin) return null;
  if (!/^https?:$/.test(u.protocol)) return null;
  u.hash = '';
  return { url: u.toString(), name: u.pathname || '/' };
}

/** What one page is asked to check. Look-only on purpose: a check the user
 * never asked for must not click, submit or buy anything on their site. The
 * built-in page checks and the visual check run on every page regardless of
 * what this says; the words here steer what the model reports on top of them. */
export function checkInstruction(address: string): string {
  return (
    `Open ${address} and look at it. Do not click, type or submit anything. ` +
    'Report a problem if the page fails to load, shows an error message, has text or images that are obviously broken or missing, ' +
    'or has buttons and links that clearly lead nowhere. If it looks fine, say so.'
  );
}

export interface CheckSummaryInput {
  /** Pages the check actually got through. */
  pagesChecked: number;
  /** Controls found on those pages while mapping. */
  controlsFound: number;
  /** Pages that came back with a problem. */
  problems: number;
  /** True when the page list was cut short. */
  capped?: boolean;
}

/** The one line a non-engineer reads. Deliberately counts controls FOUND, not
 * controls operated: a look-only check never presses anything, so "0 controls"
 * would be both true and useless — what the number is for is saying how much
 * of the site was in view. */
export function renderCheckSummary(s: CheckSummaryInput): string {
  const word = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
  const found =
    s.problems === 0
      ? 'nothing looked broken'
      : `${word(s.problems, 'problem')} — ${s.problems === 1 ? 'it is' : 'they are'} listed below`;
  const capped = s.capped ? ` ${LITE_CAP_NOTE}` : '';
  return `Checked ${word(s.pagesChecked, 'page')} and ${word(s.controlsFound, 'control')} on them; ${found}.${capped}`;
}
