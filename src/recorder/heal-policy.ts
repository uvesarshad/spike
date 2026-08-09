/* A21 (P2, reframed for autonomy 2026-08-08) — risk-tiered heal acceptance.
 *
 * `--heal` (engine.ts) re-engages the AI driver on a script's original task
 * when a replay fails, and used to save whatever came back over the SAME
 * script name unconditionally — a heal that "fixes" a script by routing
 * around a genuine regression silently turns a real bug green.
 *
 * `classifyHeal()` is a pure, deterministic structural diff between the OLD
 * (currently active) script and the NEW (freshly re-recorded) candidate —
 * no model call, explainable, auditable (see the options doc's rejection of
 * "AI judges the diff": that reintroduces hallucination at exactly the
 * moment correctness is decided). It never looks at anything except the two
 * `QaScript` step lists.
 *
 * Tiers (docs/plan/26-08-08-options-autonomy-layer.md, "A21 — Risk-tiered
 * heal acceptance"):
 *   - auto       same step count, same step types in the same order,
 *                assertion payloads byte-identical; only `target`
 *                descriptors changed on non-assertion steps (a locator
 *                moved; intent unchanged).
 *   - notice     steps added that are navigation/wait only; assertions
 *                unchanged.
 *   - quarantine any step removed, any assertion removed/weakened
 *                (`exact`→`contains`, or a `contains` string that got
 *                shorter or became a prefix), or re-targeted.
 *
 * Quarantine is the safe default: anything this module can't confidently
 * explain as "just a locator move" or "just an added wait" falls through to
 * quarantine rather than being guessed as auto/notice — mirrors the options
 * doc's fallback option ("quarantine everything") as the floor under the
 * smarter classifier, never below it. */

import type { QaScript, ScriptStep, ScriptTarget } from './script.js';

export type HealTier = 'auto' | 'notice' | 'quarantine';

export interface HealClassification {
  tier: HealTier;
  /** Human-readable, specific reasons — always non-empty for 'notice'/
   * 'quarantine'; may be empty for a byte-identical-apart-from-target 'auto'. */
  reasons: string[];
}

/** Assertion step types — the only steps whose PAYLOAD must survive a heal
 * unchanged for anything better than 'quarantine'. */
function isAssertionStep(s: ScriptStep): s is Extract<ScriptStep, { type: 'assert_dom' | 'assert_visual' }> {
  return s.type === 'assert_dom' || s.type === 'assert_visual';
}

/** Steps a heal may INSERT without quarantining.
 *
 * Originally nav/wait only. Widened to every non-assertion step after the
 * dogfood drift test (2026-08-09): the UI gained a required interaction, the
 * AI correctly re-derived a script with one extra `click`, and quarantining
 * that made `--heal` useless for the exact case it exists to serve — real UI
 * drift usually ADDS or MOVES interaction steps, it rarely just relocates a
 * locator.
 *
 * Widening is safe because step count was never the safety property —
 * ASSERTIONS are. A heal cannot launder a regression into green by adding
 * clicks: every original assertion still has to survive unchanged (checked
 * separately) and still has to PASS on replay. What must never be waved
 * through is a step being REMOVED, or an assertion being removed, weakened,
 * or re-targeted — those remain quarantine, and an inserted ASSERTION is
 * excluded here too, since a heal inventing its own expectations is exactly
 * the "AI marks its own homework" case this gate is for. */
function isInsertableStep(s: ScriptStep): boolean {
  return !isAssertionStep(s);
}

function targetsEqual(a: ScriptTarget | undefined, b: ScriptTarget | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.role === b.role && (a.name ?? '') === (b.name ?? '') && (a.nth ?? 0) === (b.nth ?? 0) && (a.qaId ?? '') === (b.qaId ?? '');
}

/** A `contains` string is WEAKER than the one it replaced when it accepts a
 * strict superset of what would have passed before: shorter text always
 * matches more pages, and a proper prefix of the old string is exactly the
 * "exact → contains"-style narrowing the audit calls out (the old assertion
 * demanded the full phrase; the new one is satisfied by its opening words). */
function isWeakenedContains(oldStr: string, newStr: string): boolean {
  if (oldStr === newStr) return false;
  if (newStr.length < oldStr.length) return true;
  return oldStr.startsWith(newStr);
}

/** Compare two assertion steps already known to be paired (same position
 * among assertions in the old vs. new script). Returns a human reason when
 * they differ in any way that must quarantine the heal, else null. */
function compareAssertion(o: ScriptStep, w: ScriptStep, index: number): string | null {
  if (o.type !== w.type) {
    return `assertion #${index + 1} changed type (${o.type} → ${w.type})`;
  }
  if (o.type === 'assert_dom' && w.type === 'assert_dom') {
    const retargeted = !targetsEqual(o.target, w.target);
    const contentChanged = o.contains !== w.contains;
    if (!retargeted && !contentChanged) return null;
    if (contentChanged && isWeakenedContains(o.contains, w.contains)) {
      return `assertion #${index + 1} weakened: assert_dom contains ${JSON.stringify(o.contains)} → ${JSON.stringify(w.contains)}${retargeted ? ' (also re-targeted)' : ''}`;
    }
    if (contentChanged) {
      return `assertion #${index + 1} changed: assert_dom contains ${JSON.stringify(o.contains)} → ${JSON.stringify(w.contains)}${retargeted ? ' (also re-targeted)' : ''}`;
    }
    return `assertion #${index + 1} re-targeted: assert_dom (content unchanged, locator moved)`;
  }
  if (o.type === 'assert_visual' && w.type === 'assert_visual') {
    const modeChanged = (o.mode ?? 'screenshot') !== (w.mode ?? 'screenshot');
    const expectationChanged = o.expectation !== w.expectation;
    if (!modeChanged && !expectationChanged) return null;
    return `assertion #${index + 1} changed: assert_visual expectation/mode differs`;
  }
  return null;
}

/** A locator-bearing step's target, or undefined for steps with no target
 * concept (navigate, wait, press_key, …) or for `drag_and_drop` whose
 * locator lives on `.source`/`.target` instead of `.target` — handled by the
 * caller via `stepTargets()` below. */
function primaryTarget(s: ScriptStep): ScriptTarget | undefined {
  switch (s.type) {
    case 'click':
    case 'type':
    case 'hover':
    case 'select_option':
    case 'assert_dom':
    case 'upload_file':
    case 'blur':
      return s.target;
    case 'extract':
      return s.target;
    default:
      return undefined;
  }
}

/** All the locator descriptors carried by a step, in a stable order — used
 * only to detect "only the target changed" (never to change semantics). */
function stepTargets(s: ScriptStep): ScriptTarget[] {
  if (s.type === 'drag_and_drop') return [s.source, ...(s.target ? [s.target] : [])];
  const t = primaryTarget(s);
  return t ? [t] : [];
}

/** A step's payload signature IGNORING any target/locator field — two steps
 * with the same kind() are "the same action" whether or not their locator
 * moved. Assertion steps are never passed in here (they're compared
 * separately by `compareAssertion`, target included, since re-targeting an
 * assertion is itself risky). */
function nonTargetKind(s: ScriptStep): string {
  switch (s.type) {
    case 'navigate': return `navigate:${s.url}`;
    case 'click': return 'click';
    case 'type': return `type:${s.text}`;
    case 'hover': return 'hover';
    case 'press_key': return `press_key:${s.key}`;
    case 'select_option': return `select_option:${s.value}`;
    case 'reload': return 'reload';
    case 'go_back': return 'go_back';
    case 'extract': return `extract:${s.key}:${s.pattern ?? ''}:${s.prompt ?? ''}`;
    case 'wait': return `wait:${s.ms}`;
    case 'upload_file': return `upload_file:${JSON.stringify(s.paths)}`;
    case 'drag_and_drop': return 'drag_and_drop';
    case 'blur': return 'blur';
    case 'mouse': return `mouse:${s.kind}:${s.x}:${s.y}`;
    case 'open_tab': return `open_tab:${s.url}`;
    case 'switch_tab': return `switch_tab:${s.tabIndex}`;
    case 'close_tab': return `close_tab:${s.tabIndex}`;
    case 'script': return `script:${JSON.stringify(s.steps)}`;
    // unreachable for assertion steps — callers filter them out before this
    // function runs — but a total switch keeps this exhaustive/type-safe.
    case 'assert_dom': return `assert_dom:${s.contains}`;
    case 'assert_visual': return `assert_visual:${s.expectation}:${s.mode ?? ''}`;
  }
}

interface AlignResult {
  /** Non-assertion steps whose only difference from their old counterpart
   * was a target/locator move — reported as the 'auto' reasons. */
  targetOnlyChanges: string[];
  /** Count of steps present in `newSteps` with no counterpart in `oldSteps`
   * (non-assertion insertions — see isInsertableStep for why that is safe). */
  insertedCount: number;
}

/** Greedily aligns `oldSteps` against `newSteps` in order. Every old step
 * must find a same-kind counterpart (target aside) at or after the current
 * new-side cursor; any new step skipped over to get there must be a
 * navigation/wait step (an allowed insertion) or alignment fails outright
 * (a step was removed, reordered around, or replaced with something else —
 * always quarantine). Returns null when alignment is impossible. */
function alignAndCompare(oldSteps: ScriptStep[], newSteps: ScriptStep[]): AlignResult | null {
  const targetOnlyChanges: string[] = [];
  let insertedCount = 0;
  let i = 0;
  let j = 0;
  while (i < oldSteps.length) {
    if (j >= newSteps.length) return null; // ran out of new steps — something was removed
    const o = oldSteps[i];
    const w = newSteps[j];
    if (o.type === w.type && !isAssertionStep(o) && !isAssertionStep(w) && nonTargetKind(o) === nonTargetKind(w)) {
      const ot = stepTargets(o);
      const wt = stepTargets(w);
      const sameTargets = ot.length === wt.length && ot.every((t, k) => targetsEqual(t, wt[k]));
      if (!sameTargets) targetOnlyChanges.push(`step ${i + 1} (${o.type}) target moved`);
      i++;
      j++;
      continue;
    }
    if (isAssertionStep(o) && isAssertionStep(w)) {
      // Assertions are validated for exact equality by the caller BEFORE
      // alignAndCompare ever runs (any diff quarantines immediately), so
      // reaching here means they already matched — consume both in lockstep.
      i++;
      j++;
      continue;
    }
    if (isInsertableStep(w)) {
      // Treat `w` as an inserted step and try the same old step against the
      // next new step.
      insertedCount++;
      j++;
      continue;
    }
    return null; // an unexplained mismatch — never guess, quarantine instead
  }
  // Any remaining new-side steps must themselves be trailing insertions.
  while (j < newSteps.length) {
    if (!isInsertableStep(newSteps[j])) return null;
    insertedCount++;
    j++;
  }
  return { targetOnlyChanges, insertedCount };
}

/**
 * Classify a heal candidate against the script it would replace. Pure and
 * deterministic — no model call, no I/O. See the module header for the tier
 * definitions and docs/plan/26-08-08-options-autonomy-layer.md ("A21") for
 * the design this implements.
 */
export function classifyHeal(oldScript: QaScript, newScript: QaScript): HealClassification {
  const oldSteps = oldScript.steps;
  const newSteps = newScript.steps;
  const reasons: string[] = [];

  // 1. Any outright step-count shrink means something was removed — no need
  //    to look further to know this is quarantine-worthy (a specific reason
  //    still helps a human reviewing the candidate later).
  if (newSteps.length < oldSteps.length) {
    reasons.push(`step count decreased (${oldSteps.length} → ${newSteps.length}) — at least one recorded step was removed`);
  }

  // 2. Assertions: extracted positionally, compared for removal / weakening /
  //    re-targeting / any other content change — all of which quarantine.
  const oldAssertions = oldSteps.filter(isAssertionStep);
  const newAssertions = newSteps.filter(isAssertionStep);
  if (newAssertions.length < oldAssertions.length) {
    reasons.push(`assertion count decreased (${oldAssertions.length} → ${newAssertions.length})`);
  }
  const n = Math.min(oldAssertions.length, newAssertions.length);
  for (let i = 0; i < n; i++) {
    const diff = compareAssertion(oldAssertions[i], newAssertions[i], i);
    if (diff) reasons.push(diff);
  }

  if (reasons.length > 0) {
    return { tier: 'quarantine', reasons };
  }

  // 3. No step removed, no assertion touched. What's left to check is
  //    whether the non-assertion steps line up 1:1 (target moves allowed) with
  //    only navigation/wait insertions permitted beyond that.
  const aligned = alignAndCompare(oldSteps, newSteps);
  if (!aligned) {
    return { tier: 'quarantine', reasons: ['steps could not be aligned with the original without an unexplained change (a step was removed, reordered, replaced, or an ASSERTION was inserted)'] };
  }

  if (aligned.insertedCount > 0) {
    return {
      tier: 'notice',
      reasons: [`${aligned.insertedCount} navigation/wait step(s) added; assertions unchanged`, ...aligned.targetOnlyChanges],
    };
  }

  return { tier: 'auto', reasons: aligned.targetOnlyChanges };
}
