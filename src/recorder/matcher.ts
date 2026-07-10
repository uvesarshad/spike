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

const DEFAULT_THRESHOLD = 0.62;
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

/** Bag-of-significant-words for task similarity: lowercase, strip
 * punctuation, drop `{{...}}` placeholders (run-data/secrets never affect
 * matching), drop stopwords and very short tokens. */
function tokenize(task: string): Set<string> {
  return new Set(
    task
      .toLowerCase()
      .replace(/\{\{[^}]+\}\}/g, ' ')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  );
}

/** Jaccard similarity of two token sets: 0 (disjoint) .. 1 (identical). Two
 * empty sets (degenerate/blank tasks) are treated as trivially equal. */
function jaccard(a: Set<string>, b: Set<string>): number {
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
 * Score every recorded script against (task, url) and return the best
 * candidate over `threshold`, or null when nothing is confident enough.
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
export function matchReplayScript(task: string, url: string, opts: ReplayMatchOptions = {}): ReplayMatch | null {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const targetHost = bareHost(url);
  const targetPath = pathOf(url);
  const targetTokens = tokenize(task);

  let best: ReplayMatch | null = null;
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
    if (score >= threshold && (!best || score > best.score)) {
      best = { name: script.name, score };
    }
  }
  return best;
}
