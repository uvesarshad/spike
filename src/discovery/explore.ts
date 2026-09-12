/* E7 — the exploration pass: the third and last layer of the discovery
 * ladder, and the only one that spends model calls.
 *
 * Layers 1 and 2 (static route extraction, the deterministic crawl) can only
 * ever find what is reachable by following a link. A very large part of a
 * real app is not: a pop-up that has to be dismissed before the page under it
 * is readable, a "show more" section, a set of tabs where each tab is a
 * different screen, a multi-step form where step 2 does not exist until step 1
 * is accepted. None of that carries an address the crawl can queue, so before
 * this it was simply invisible to the map — and therefore invisible to
 * coverage, which then reported a number for an app it had only half seen.
 *
 * This module drives that surface open: on each page the crawl flagged as
 * having controls it could not follow, it shows the page's controls to the
 * cheap model that already picks a run's clicks, clicks the one thing the
 * model thinks hides more of the app, and records whatever appears as another
 * state (or another address) in the same ledger everything else lands in.
 *
 * Cost is the whole design constraint, so it is bounded three ways and
 * bounded low: actions per page, actions per whole pass, and pages looked at
 * per pass. A page where the model says "nothing here" costs exactly ONE call
 * and no clicks. Nothing here retries, and nothing here is allowed to grow
 * with the size of the site.
 *
 * Like the rest of this layer it imports no browser and no model client — the
 * two are taken structurally (the small shapes below), which both keeps the
 * discovery layer free of engine dependencies and makes the whole pass
 * testable with no browser and no network. */

import { normalizeUrlForActionCache } from '../cache/action-cache.js';
import type { ExploredState } from './app-model.js';
import { interactiveElementsFromAx } from './browser-crawl.js';
import type { InteractiveElement } from './html.js';
import { structuralSignatureFromAx } from './signature.js';

/** Default: how many things to click on any one page. Deliberately tiny — the
 * point is to crack a page open, not to exhaust it. */
export const DEFAULT_MAX_ACTIONS_PER_PAGE = 3;
/** Default: the ceiling for a whole pass, so mapping a 200-page site costs a
 * predictable handful of calls rather than scaling with the site. */
export const DEFAULT_MAX_ACTIONS_PER_RUN = 12;
/** Default: how many flagged pages to look at at all, in crawl order. */
export const DEFAULT_MAX_PAGES = 6;
/** How long to let the page react to a click before reading it again. */
export const DEFAULT_SETTLE_MS = 400;

/** One node of the page's control tree. Taken structurally for the same
 * reason the browser below is; a real accessibility-tree node already
 * satisfies it, and `id` is the handle a click is made with. */
export interface ExploreAxNode {
  id?: string;
  role: string;
  name?: string;
  children?: ExploreAxNode[];
}

/** What the exploration pass needs from whatever is driving Chrome. Every
 * BrowserPort implementation satisfies this as-is. */
export interface ExploreBrowser {
  navigate(url: string): Promise<void>;
  url(): Promise<string>;
  axTree(): Promise<{ root: ExploreAxNode }>;
  click(nodeId: string): Promise<void>;
  waitForIdle?(opts?: { quietMs?: number; timeoutMs?: number }): Promise<void>;
}

/** The model that picks the click. `ModelRouter.planJson` — the same cheap
 * per-step picker a live run uses — satisfies this exactly; a test hands in a
 * canned function. */
export interface ExplorePlanner {
  planJson(prompt: string, schema: object, step: number): Promise<unknown>;
}

/** A control the crawl saw but could not follow, and the page it was on. */
export interface InteractionGatedCandidate {
  /** The route (normalized URL) the candidate control was found on. */
  route: string;
  role: string;
  name?: string;
  reason: string;
}

export interface ExplorationResult {
  /** Everything the pass uncovered, ready for the ledger. */
  states: ExploredState[];
  /** Clicks actually made (never more than the per-pass cap). */
  actionsUsed: number;
  /** Model calls actually made (one per look at a page, plus one per click). */
  modelCalls: number;
  /** Pages opened and looked at. */
  pagesVisited: number;
  /** True when a cap cut the pass short — i.e. there was more to look at. */
  stoppedAtCap: boolean;
}

export interface InteractionExplorerOptions {
  browser: ExploreBrowser;
  planner: ExplorePlanner;
  /** Clicks per page. Default 3. */
  maxActionsPerPage?: number;
  /** Clicks for the whole pass. Default 12. */
  maxActionsPerRun?: number;
  /** Pages looked at in the whole pass. Default 6. */
  maxPages?: number;
  /** Addresses outside this origin are never recorded and end that page's
   * exploration (a click that leaves the site is not this site's surface).
   * Defaults to each starting page's own origin. */
  allowedOrigin?: string;
  settleMs?: number;
  /** Plain-English progress lines for a caller that shows them. */
  onProgress?: (line: string) => void;
}

/** The reply shape asked of the model. Kept to one decision so the cheapest
 * possible model can answer it. */
export const EXPLORE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['click', 'done'] },
    control: { type: 'string', description: 'id of the control to click, e.g. n7 (only when action is click)' },
    why: { type: 'string', description: 'a few words on what you expect to appear' },
  },
  required: ['action'],
} as const;

/** Controls we refuse to touch no matter what comes back. Mapping is a
 * read-mostly errand run against someone's real site: opening a panel is
 * fine, placing an order or emptying an account is not. Matched against the
 * control's visible name. */
const OFF_LIMITS_NAME = /\b(delete|remove|destroy|deactivate|cancel account|close account|unsubscribe|sign out|log ?out|buy|pay|purchase|place order|checkout|confirm order|send|submit|publish|transfer|withdraw)\b/i;

/** Controls worth offering as "this might hide more of the app". Links are
 * excluded on purpose: the crawl already follows those, and paying a model to
 * re-find them would be spending money on the layer below's job. */
const EXPLORABLE_ROLES = new Set(['button', 'tab', 'menuitem', 'switch', 'checkbox']);

interface PageSnapshot {
  url: string;
  normalizedUrl: string;
  root: ExploreAxNode;
  signature: string;
  elements: InteractiveElement[];
}

interface OfferedControl {
  id: string;
  role: string;
  name: string;
}

/** Every offerable control in a tree, in document order, deduplicated by
 * role+name and capped so one enormous page cannot blow up the prompt. */
export function offerableControls(root: ExploreAxNode | undefined, max = 40): OfferedControl[] {
  const out: OfferedControl[] = [];
  const seen = new Set<string>();
  const walk = (node: ExploreAxNode | undefined, depth: number): void => {
    if (!node || depth > 200 || out.length >= max) return;
    const name = (node.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (node.id && EXPLORABLE_ROLES.has(node.role) && !OFF_LIMITS_NAME.test(name)) {
      const key = `${node.role}|${name.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ id: node.id, role: node.role, name });
      }
    }
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  walk(root, 0);
  return out;
}

/** The one question put to the model, in plain words. */
export function buildExplorePrompt(page: { url: string }, controls: OfferedControl[], alreadyTried: string[]): string {
  const list = controls.map((c) => `${c.id} ${c.role}${c.name ? ` "${c.name}"` : ''}`).join('\n');
  const tried = alreadyTried.length ? alreadyTried.join('\n') : '(nothing yet)';
  return [
    'You are looking at one page of a website to find parts of it that only show up after someone clicks something:',
    'a pop-up that has to be dealt with, a "show more" or "load more" section, a tab that swaps the content, a',
    'collapsed panel, or the next step of a form.',
    '',
    `Page: ${page.url}`,
    '',
    'Controls on the page right now:',
    list || '(none)',
    '',
    'Already clicked on this page — do not pick these again:',
    tried,
    '',
    'Pick ONE control that is likely to reveal something that is not on screen yet. Prefer things like "show more",',
    '"load more", "continue", "next", "accept", "open", "details", a tab, or a collapsed section.',
    'Never pick anything that signs out, deletes, buys, pays, sends or publishes.',
    'If nothing on this page looks like it hides more of the app, answer done.',
  ].join('\n');
}

interface Decision {
  action: 'click' | 'done';
  control?: string;
}

/** Read the model's reply defensively: anything unparseable, unexpected or
 * pointing at a control that is not on offer means "stop looking at this
 * page", never a crash and never a retry. */
export function parseExploreDecision(raw: unknown): Decision {
  if (!raw || typeof raw !== 'object') return { action: 'done' };
  const obj = raw as { action?: unknown; control?: unknown; nodeId?: unknown };
  const action = obj.action === 'click' ? 'click' : 'done';
  if (action === 'done') return { action: 'done' };
  const control = typeof obj.control === 'string' ? obj.control.trim() : typeof obj.nodeId === 'string' ? obj.nodeId.trim() : '';
  if (!control) return { action: 'done' };
  return { action: 'click', control };
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** Build the hook `discoverApp`'s `exploreInteractionGated` option takes. The
 * factory shape is deliberate: it keeps `discoverApp` itself free of any
 * knowledge of a browser or a model, exactly as it was before. */
export function makeInteractionExplorer(opts: InteractionExplorerOptions): (candidates: InteractionGatedCandidate[]) => Promise<ExplorationResult> {
  const maxPerPage = Math.max(0, Math.floor(opts.maxActionsPerPage ?? DEFAULT_MAX_ACTIONS_PER_PAGE));
  const maxPerRun = Math.max(0, Math.floor(opts.maxActionsPerRun ?? DEFAULT_MAX_ACTIONS_PER_RUN));
  const maxPages = Math.max(0, Math.floor(opts.maxPages ?? DEFAULT_MAX_PAGES));
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  const { browser, planner } = opts;

  const settle = async (): Promise<void> => {
    try {
      await browser.waitForIdle?.({ quietMs: settleMs, timeoutMs: 8_000 });
    } catch {
      /* a page that never goes quiet is still worth reading as it stands */
    }
  };

  const snapshot = async (fallbackUrl: string): Promise<PageSnapshot | null> => {
    let root: ExploreAxNode;
    try {
      root = (await browser.axTree())?.root;
    } catch {
      return null;
    }
    if (!root) return null;
    let url = fallbackUrl;
    try {
      url = (await browser.url()) || fallbackUrl;
    } catch {
      /* keep the address we asked for */
    }
    return {
      url,
      normalizedUrl: normalizeUrlForActionCache(url),
      root,
      signature: structuralSignatureFromAx(root),
      elements: interactiveElementsFromAx(root),
    };
  };

  return async (candidates: InteractionGatedCandidate[]): Promise<ExplorationResult> => {
    const result: ExplorationResult = { states: [], actionsUsed: 0, modelCalls: 0, pagesVisited: 0, stoppedAtCap: false };
    if (maxPerRun === 0 || maxPerPage === 0 || maxPages === 0) return result;

    // Crawl order, one entry per page — a page with twelve unfollowable
    // buttons is still one page to look at.
    const routes: string[] = [];
    for (const c of candidates) if (!routes.includes(c.route)) routes.push(c.route);

    for (const route of routes) {
      if (result.pagesVisited >= maxPages || result.actionsUsed >= maxPerRun) {
        result.stoppedAtCap = true;
        break;
      }
      try {
        await browser.navigate(route);
      } catch {
        continue; // a page we cannot open is a dead end, not a failure
      }
      result.pagesVisited++;
      await settle();

      const origin = opts.allowedOrigin ?? originOf(route);
      let current = await snapshot(route);
      if (!current) continue;
      opts.onProgress?.(`Looking for anything hidden behind a click on ${route}…`);

      const tried: string[] = [];
      let usedHere = 0;
      while (usedHere < maxPerPage && result.actionsUsed < maxPerRun) {
        const controls = offerableControls(current.root).filter((c) => !tried.includes(labelOf(c)));
        if (controls.length === 0) break;

        let decision: Decision;
        try {
          result.modelCalls++;
          decision = parseExploreDecision(await planner.planJson(buildExplorePrompt(current, controls, tried), EXPLORE_JSON_SCHEMA, result.modelCalls));
        } catch {
          break; // one unusable answer ends this page; never retried
        }
        if (decision.action !== 'click') break;

        const target = controls.find((c) => c.id === decision.control) ?? controls.find((c) => labelOf(c) === decision.control);
        if (!target) break; // picked something that is not on the page

        tried.push(labelOf(target));
        const before = current;
        try {
          await browser.click(target.id);
        } catch {
          break; // the control would not take a click — move to the next page
        }
        usedHere++;
        result.actionsUsed++;
        await settle();

        const after = await snapshot(before.url);
        if (!after) break;

        if (origin && originOf(after.url) !== origin) {
          // The click left the site. Nothing off-site belongs in this app's
          // map, and there is no telling where we are now — go back and stop.
          await browser.navigate(route).catch(() => {});
          break;
        }

        const movedPage = after.normalizedUrl !== before.normalizedUrl;
        const changedState = after.signature !== before.signature;
        if (movedPage || changedState) {
          result.states.push({
            route: after.normalizedUrl,
            structuralSignature: after.signature,
            elements: after.elements,
            revealedBy: describe(target),
          });
          opts.onProgress?.(movedPage ? `"${describe(target)}" opened ${after.url}.` : `"${describe(target)}" revealed more of ${after.url}.`);
        }
        current = after;
      }

      if (usedHere >= maxPerPage) result.stoppedAtCap = true;
    }

    if (result.actionsUsed >= maxPerRun) result.stoppedAtCap = true;
    return result;
  };
}

function labelOf(c: OfferedControl): string {
  return `${c.role}|${c.name.toLowerCase()}`;
}

function describe(c: OfferedControl): string {
  return c.name || c.role;
}
