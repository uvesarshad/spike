/* Pre-run replay matcher (Phase 14) — before a fresh AI run, check whether an
 * existing recorded script (generated-tests/*.json) already covers this
 * task+url closely enough to replay deterministically at $0 instead of
 * spending navigator/brain tokens on a fresh AI run.
 *
 * READ-ONLY over the recorder's JSON shape: this module never imports from or
 * mutates recorder/script.ts or recorder/replay.ts internals — it only reuses
 * the exported `listScripts`/`loadScript` helpers those modules already expose
 * to load the scripts they produce/consume. */

import { listScripts, loadScript, type QaScript } from './script.js';

export interface ReplayMatchOptions {
  /** Root directory containing generated-tests/ — mirrors `listScripts`'s
   * `root` param (default `process.cwd()`). Override for tests. */
  dir?: string;
  /** Minimum combined score in [0,1] to consider a match "confident" enough to
   * replay instead of running a fresh AI pass. */
  threshold?: number;
}

export interface ReplayMatch {
  /** Script name (`QaScript.name`) — pass straight to `qaReplay()`. */
  name: string;
  /** Combined score in [0,1]; only ever returned when >= threshold. */
  score: number;
}

export interface ReplayMatchDetailed {
  /** Same as `matchReplayScript()`'s return value: null unless a same-host
   * candidate scored >= threshold. */
  matched: ReplayMatch | null;
  /** The single highest-scoring same-host candidate, REGARDLESS of whether it
   * cleared `threshold` — present whenever at least one script shares the
   * target's host, absent only when there is no host-eligible candidate at
   * all. Lets a caller surface "you had a near-miss script" even on a run
   * that falls through to a fresh AI pass (A10). */
  bestCandidate?: ReplayMatch;
  /** The threshold that was applied, echoed back so callers can compute
   * "how close" a sub-threshold bestCandidate came without importing the
   * default constant separately. */
  threshold: number;
}

/** Minimum threshold to attempt a $0 replay instead of a fresh AI pass.
 * Exported (rather than a private module constant) so it's tunable/testable
 * without duplicating the number — A10 (P1). Do not change this default;
 * override per-call via `ReplayMatchOptions.threshold` instead. */
export const DEFAULT_THRESHOLD = 0.62;
/** A sub-threshold bestCandidate within this margin of `threshold` is close
 * enough to be worth telling the user about ("a rename/rewording cost you a
 * paid run") rather than silently falling through to a fresh AI pass. */
export const NEAR_MISS_MARGIN = 0.15;
const TASK_WEIGHT = 0.7;
const PATH_WEIGHT = 0.3;

/** Common connective words that carry no discriminating signal between two
 * QA task descriptions ("log in and check out" vs "log in and add to cart"
 * share most of these) — dropped before scoring so real task-specific nouns
 * and verbs dominate the similarity. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have',
  'in', 'into', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'then', 'this',
  'to', 'with', 'should', 'must', 'end', 'page', 'goes', 'go', 'using', 'via', 'onto',
]);

/** Common QA-task compound words that a plain suffix stemmer can't reduce to
 * their split-phrase equivalent ("login" is not "log" + a stemmable suffix —
 * it's "log" + the stopword "in" glued together). Mapping these directly
 * means "logs in" / "log in" / "login" all tokenize to the same {"log"},
 * closing the exact gap A10 calls out, without pulling in a real stemmer or
 * any semantic/embedding model. */
const COMPOUND_ALIASES: Record<string, string> = {
  login: 'log',
  logon: 'log',
  logout: 'log',
  signin: 'sign',
  signon: 'sign',
  signup: 'sign',
  signout: 'sign',
  checkout: 'check',
  checkin: 'check',
};

/** Deterministic, dependency-free light stemmer: strip common plural/verb
 * suffixes so inflected forms of the same word collapse to one token
 * ("logs"/"logging"/"logged" ~ "log", "checks"/"checking" ~ "check").
 * Length guards avoid over-stripping short words into noise (e.g. "as" -> "a"
 * never happens — those are filtered as stopwords/too-short anyway). Order
 * matters: longer/more specific suffixes before the generic trailing 's'. */
function stem(word: string): string {
  const alias = COMPOUND_ALIASES[word];
  if (alias) return alias;
  if (word.length > 6 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 5 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 5 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** Bag-of-significant-words for task similarity: lowercase, strip
 * punctuation, drop `{{...}}` placeholders (run-data/secrets never affect
 * matching), stem, drop stopwords and very short tokens. Stopwords/length are
 * checked AFTER stemming so a stem that collapses into a stopword-length
 * token (rare, but e.g. plural of a 4-letter word) is still filtered. */
export function tokenize(task: string): Set<string> {
  return new Set(
    task
      .toLowerCase()
      .replace(/\{\{[^}]+\}\}/g, ' ')
      .split(/[^a-z0-9]+/)
      .map(stem)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  );
}

/** Jaccard similarity of two token sets: 0 (disjoint) .. 1 (identical). Two
 * empty sets (degenerate/blank tasks) are treated as trivially equal. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** host:port with a leading `www.` stripped from the hostname so apex/www
 * siblings compare equal (mirrors engine.ts's targetHostCandidates
 * tolerance), but the PORT is kept: this codebase's whole dev workflow is
 * many different local apps all on hostname 'localhost' at different ports
 * (fixturePort 9401, some other app on 3000, …) — dropping the port would let
 * a script recorded against one app match a request against a completely
 * different one just because both say 'localhost'. '' on unparseable url. */
function bareHost(url: string): string {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    const host = h.startsWith('www.') ? h.slice(4) : h;
    return u.port ? `${host}:${u.port}` : host;
  } catch {
    return '';
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/\/+$/, '') || '/';
  } catch {
    return '';
  }
}

/** Path similarity: 1 for an exact match, 0.5 for a shared first path segment
 * (e.g. /checkout vs /checkout/step-2), else 0. */
function pathSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const segA = a.split('/').filter(Boolean);
  const segB = b.split('/').filter(Boolean);
  if (segA.length && segB.length && segA[0] === segB[0]) return 0.5;
  return 0;
}

/**
 * Score every recorded script against (task, url) and return both the best
 * candidate over `threshold` (`matched`, null if nothing is confident enough)
 * AND the single best same-host candidate regardless of threshold
 * (`bestCandidate`) — so a caller can surface a near-miss (A10, P1) instead of
 * silently paying for a fresh AI run with no indication a close script
 * existed.
 *
 * Host is a hard gate (apex/www-tolerant via `bareHost`): a script recorded
 * against a different site is never a candidate no matter how similar the
 * task text reads, because replay navigates to the SCRIPT's own recorded url
 * (see recorder/replay.ts), not the caller's — a host mismatch would silently
 * test the wrong site. Within same-host candidates, ranking blends task-text
 * similarity (0.7) with path similarity (0.3): the task text is the primary
 * signal (two different flows on the same host, e.g. /login vs /admin, should
 * rarely tie on task alone), the path is a tie-breaker/confidence booster.
 */
export function matchReplayScriptDetailed(task: string, url: string, opts: ReplayMatchOptions = {}): ReplayMatchDetailed {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const targetHost = bareHost(url);
  const targetPath = pathOf(url);
  const targetTokens = tokenize(task);

  let best: ReplayMatch | null = null;
  let bestOverall: ReplayMatch | null = null;
  for (const p of listScripts(opts.dir)) {
    let script: QaScript;
    try {
      script = loadScript(p);
    } catch {
      continue; // corrupt/unreadable script on disk — skip, never fail the caller's run
    }
    if (!script.steps.length) continue;
    if (targetHost && bareHost(script.url) !== targetHost) continue; // hard gate

    const taskSim = jaccard(targetTokens, tokenize(script.task));
    const pathSim = pathSimilarity(targetPath, pathOf(script.url));
    const score = TASK_WEIGHT * taskSim + PATH_WEIGHT * pathSim;
    const candidate = { name: script.name, score };
    if (!bestOverall || score > bestOverall.score) bestOverall = candidate;
    if (score >= threshold && (!best || score > best.score)) best = candidate;
  }
  return { matched: best, bestCandidate: bestOverall ?? undefined, threshold };
}

/** Back-compat entry point: same signature/behavior as before A10 — returns
 * only the confident match, or null. New callers that want near-miss
 * visibility should use `matchReplayScriptDetailed()` directly (engine.ts
 * does). */
export function matchReplayScript(task: string, url: string, opts: ReplayMatchOptions = {}): ReplayMatch | null {
  return matchReplayScriptDetailed(task, url, opts).matched;
}
