/* The driver loop — a11y-tree-first, vision on demand, two-tier model split.
 *
 * A smart BRAIN plans ONCE (an ordered sub-goal checklist) and is re-consulted
 * only when the cheap NAVIGATOR gets stuck; the navigator reads the page and
 * picks 1-3 actions EVERY step. This makes brain cost ~O(stuck events) instead
 * of O(steps), so a run can go long at near-navigator cost.
 *
 * Per navigator step: snapshot tree → navigator picks actions (or reports
 * goalComplete / blocked) → execute via the port → drain console/network into
 * the step record (exact per-step correlation).
 * Escalate to the brain on: navigator `blocked`; same action 3× (was: end the
 * run — now re-plans FIRST); invalid navigator JSON twice; a per-goal step
 * overflow; or a finish:pass the confirmation visual disagrees with. Brain
 * escalations without progress are capped so a truly stuck run ends honestly.
 * Other policies unchanged: action throw → one retry after re-resolving the
 * target by role+name in a fresh tree; visual fail → run fails; finish:pass →
 * one confirmation visual before accepting; finish:fail → trusted. */

import type { AxNode, AxSnapshot, BrowserPort } from '../ports/browser-port.js';
import { firstError } from '../capture/console-network.js';
import type { ModelRouter } from '../router/model-router.js';
import type { ArtifactStore } from '../report/artifacts.js';
import { describeAction, slimReport, type FailingStep, type Report, type SpendSummary, type StepRecord, type RunVerdict } from '../report/report.js';
import {
  buildExtractPrompt,
  EXTRACT_JSON_SCHEMA,
  ExtractResultSchema,
  GOAL_PLAN_JSON_SCHEMA,
  GoalPlanSchema,
  PLAN_JSON_SCHEMA,
  PlanResultSchema,
  type Action,
  type GoalPlan,
  type PlanResult,
} from './actions.js';
import { buildGoalPlannerPrompt, buildNavigatorPrompt } from './planner-prompt.js';
import type { Vault } from '../vault/vault.js';
import { runVisualAssertion, type AssertionPolicy, type AssertionResult, type AssertionTraceEntry } from '../assertions/policy.js';
import { validateScriptSteps, runScriptSteps } from './script-runner/index.js';
import { createRunDataState, recordExtraction, resolveRunPlaceholders, RunDataNotFoundError } from '../run-data/index.js';
import {
  ActionCacheRejectedError,
  FileActionCache,
  actionFromCachedValue,
  buildActionCacheKey,
  captureActionEffectState,
  toCachedActionValue,
  verifyActionEffect,
  type CachedActionValue,
} from '../cache/action-cache.js';
import { getDefaultTracer } from '../telemetry/env.js';
import { startClipRecorder, type CdpClientLike } from '../clip/screencast.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Default global step budget for an AI run. Raised from the old 12 because the
 * brain/navigator split makes per-step cost the CHEAP navigator, so runs can go
 * long. Caller-provided LoopOptions.maxSteps always wins; the budget stays the
 * ultimate safety net. */
const DEFAULT_MAX_STEPS = 40;
/** Default per-goal step cap (kept small vs the global budget so it fires first):
 * a single goal grinding past this many steps without completing triggers a
 * brain re-plan. Caller-overridable via LoopOptions.perGoalMaxSteps. */
const DEFAULT_PER_GOAL_STEPS = 12;
/** Consecutive brain escalations with NO navigator progress before we give up
 * and end honestly — bounds brain cost when the page truly can't be driven. */
const MAX_BRAIN_ESCALATIONS = 2;

/** {{secret:NAME}} — NAME is [a-zA-Z0-9_-]+. Resolved AT EXECUTE TIME ONLY; the
 * placeholder is what lives in every recorded/reported/logged surface. */
const SECRET_RE = /\{\{secret:([a-zA-Z0-9_-]+)\}\}/g;

/** Thrown when a type action references a secret the vault doesn't hold. */
class SecretNotFoundError extends Error {}

/** Resolve any {{secret:NAME}} occurrences in `text` via the vault. Throws
 * SecretNotFoundError (with the qa-cli hint) when a referenced secret is missing.
 * Returns the original string unchanged when there are no placeholders. */
function resolveSecrets(text: string, vault: Vault | undefined): string {
  if (!SECRET_RE.test(text)) return text;
  SECRET_RE.lastIndex = 0;
  return text.replace(SECRET_RE, (_m, name: string) => {
    const value = vault?.get(name);
    if (value === undefined) {
      throw new SecretNotFoundError(
        `secret "${name}" not found — add it with: qa secret set ${name}`,
      );
    }
    return value;
  });
}

/** Host of a URL, lowercased; '' for unparseable/non-http urls (about:blank etc). */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** True when host is exactly in allowedHosts or a subdomain of one of them. */
function hostAllowed(host: string, allowedHosts: string[]): boolean {
  return allowedHosts.some((allowed) => {
    const a = allowed.toLowerCase();
    return host === a || host.endsWith('.' + a);
  });
}

/** Step-progress callback shape — VibeService forwards these verbatim to the UI. */
export type StepKind =
  | 'plan'
  | 'click'
  | 'type'
  | 'hover'
  | 'key'
  | 'select'
  | 'navigate'
  | 'assert'
  | 'extract'
  | 'wait'
  | 'finish'
  | 'upload'
  | 'drag'
  | 'blur'
  | 'mouse'
  | 'tab'
  | 'script';
export interface StepInfo {
  index: number;
  kind: StepKind;
  text: string;
  ok?: boolean;
}

export interface LoopOptions {
  /** Global step budget (the safety net). Defaults to DEFAULT_MAX_STEPS (40) —
   * raised from the old 12 because the brain/navigator split makes per-step cost
   * cheap, so runs can go long. A caller-provided value always wins. */
  maxSteps?: number;
  /** Per-goal step cap: a single goal that grinds past this without completing
   * triggers a brain re-plan. Defaults to min(maxSteps, DEFAULT_PER_GOAL_STEPS). */
  perGoalMaxSteps?: number;
  onStep?: (info: StepInfo) => void;
  /** Hosts the driver may click/type on; everywhere else is read-only (Tier-4).
   * navigate/asserts/wait stay allowed. Defaults to localhost/127.0.0.1 when
   * omitted so a misconfigured caller can't silently disable the guard. */
  allowedHosts?: string[];
  /** Secrets store for {{secret:NAME}} resolution at execute time. Optional:
   * without it, a {{secret:…}} placeholder fails the step (secret not found). */
  vault?: Vault;
  /** Cooperative cancellation — checked before each planner call and each
   * action; aborting ends the run 'uncertain' with reason 'cancelled by user'. */
  signal?: AbortSignal;
  /** Visual assertion policy. Defaults to the existing cheap single-ladder behavior. */
  assertionPolicy?: AssertionPolicy;
  actionCache?: FileActionCache;
  /** Phase 8: opt-in real video verdicts for `assert_visual { mode: 'video' }`.
   * OFF by default (it is costly) — MODELS lane's cfg.videoAssertions flows in
   * here via the engine. When false, mode:'video' does a safe screenshot
   * fallback and the step description notes it was disabled. */
  videoAssertions?: boolean;
  /** A5b (P1) safety: dry-run/read-only mode. When true, mutating actions
   * (click/type/upload_file/drag_and_drop/blur/mouse/open_tab/switch_tab/
   * close_tab/script/select_option/press_key) are skipped and recorded as such
   * instead of executed — navigate/observe/screenshot/asserts stay allowed. A
   * safety layer ON TOP OF the allowedHosts (Tier-4) guard, not a replacement.
   * Defaults to FALSE here (unset → today's mutate-freely behavior for any
   * direct caller, e.g. tests/spikes) — the product's safe-by-default TRUE
   * lives in DEFAULT_SETTINGS/config.DEFAULTS and must be threaded down
   * explicitly by the caller (engine.ts / lite-engine.ts). */
  readOnly?: boolean;
  /** A5a (P1) safety: optional per-run spend cap in USD. undefined/0 = no cap
   * (default). Checked once per navigator/brain call (top of the main loop);
   * see estimatedPaidSpendUsd for the approximation this makes — there is no
   * real per-adapter USD pricing available here. */
  spendCapUsd?: number;
}

/** Map an action to its onStep kind. */
function stepKind(action: Action): StepKind {
  switch (action.type) {
    case 'click':
      return 'click';
    case 'type':
      return 'type';
    case 'hover':
      return 'hover';
    case 'press_key':
      return 'key';
    case 'select_option':
      return 'select';
    case 'navigate':
    case 'reload':
    case 'go_back':
      return 'navigate';
    case 'wait':
      return 'wait';
    case 'finish':
      return 'finish';
    case 'assert_visual':
    case 'assert_dom':
      return 'assert';
    case 'extract':
      return 'extract';
    case 'upload_file':
      return 'upload';
    case 'drag_and_drop':
      return 'drag';
    case 'blur':
      return 'blur';
    case 'mouse':
      return 'mouse';
    case 'open_tab':
    case 'switch_tab':
    case 'close_tab':
      return 'tab';
    case 'script':
      return 'script';
  }
}

/** Action types that mutate the page (as opposed to navigate/observe/assert).
 * Shared by the Tier-4 allowedHosts guard AND the A5b read-only guard so both
 * agree on exactly what counts as a "mutation" — navigate/reload/go_back/wait/
 * assert_visual/assert_dom/extract/finish/hover are deliberately excluded
 * (hover is read-only; the rest are navigation/observation/verdicts). */
const MUTATING_ACTION_TYPES = new Set<Action['type']>([
  'click',
  'type',
  'select_option',
  'press_key',
  'upload_file',
  'drag_and_drop',
  'blur',
  'mouse',
  'open_tab',
  'switch_tab',
  'close_tab',
  'script',
]);

function isMutatingAction(action: Action): boolean {
  return MUTATING_ACTION_TYPES.has(action.type);
}

/** A human-readable description of an executed action, preferring the touched
 * node's role+name over the opaque nodeId. */
function humanizeAction(action: Action, target?: { role: string; name?: string }): string {
  const tgt = target ? (target.name ? `${target.role} "${target.name}"` : target.role) : undefined;
  switch (action.type) {
    case 'click':
      return `Click ${tgt ?? action.nodeId}`;
    case 'type':
      return `Type into ${tgt ?? action.nodeId}`;
    case 'hover':
      return `Hover ${tgt ?? action.nodeId}`;
    case 'press_key':
      return `Press key ${action.key}`;
    case 'select_option':
      return `Select ${JSON.stringify(action.value)} in ${tgt ?? action.nodeId}`;
    case 'navigate':
      return `Navigate to ${action.url}`;
    case 'reload':
      return 'Reload page';
    case 'go_back':
      return 'Go back';
    case 'wait':
      return `Wait ${action.ms}ms`;
    case 'finish':
      return `Finish: ${action.verdict} — ${action.reason}`;
    case 'assert_visual':
      return `Visual check: ${action.expectation}`;
    case 'assert_dom':
      return `Check ${tgt ?? action.nodeId} contains "${action.contains}"`;
    case 'extract':
      return action.prompt
        ? `Extract ${action.key} (model-assisted: ${action.prompt.slice(0, 60)})`
        : `Extract ${action.key} from ${tgt ?? action.nodeId ?? 'page'}`;
    case 'upload_file':
      return `Upload ${action.paths.length} file(s) to ${tgt ?? action.nodeId}`;
    case 'drag_and_drop':
      return `Drag ${tgt ?? action.sourceId} to ${action.targetTarget ? (action.targetTarget.name ? `${action.targetTarget.role} "${action.targetTarget.name}"` : action.targetTarget.role) : action.targetId}`;
    case 'blur':
      return `Blur ${tgt ?? action.nodeId}`;
    case 'mouse':
      return `Mouse ${action.kind} at (${Math.round(action.x)}, ${Math.round(action.y)})`;
    case 'open_tab':
      return `Open new tab: ${action.url}`;
    case 'switch_tab':
      return `Switch to tab ${action.tabId}`;
    case 'close_tab':
      return `Close tab ${action.tabId}`;
    case 'script':
      return `Run script (${action.steps.length} step(s))`;
  }
}

/** True if a console/network drain shows a page-level error (abort the batch). */
function drainHasPageError(consoleEntries: { level: string }[], networkEntries: { failed?: boolean }[]): boolean {
  return (
    consoleEntries.some((e) => e.level === 'error' || e.level === 'page-error') ||
    networkEntries.some((e) => e.failed)
  );
}

/** Best-effort: pull a visible alert/error line out of the last snapshot's tree
 * text so even the uncertain path can say WHY (e.g. "Invalid email or password"). */
function visibleErrorText(axText: string | undefined): string | null {
  if (!axText) return null;
  // prefer lines whose role looks like an alert/static text AND mention
  // error/invalid; fall back to any line mentioning error/invalid.
  let fallback: string | null = null;
  for (const line of axText.split('\n')) {
    const lower = line.toLowerCase();
    if (!lower.includes('error') && !lower.includes('invalid')) continue;
    const quoted = line.match(/"([^"]+)"/);
    const text = (quoted ? quoted[1] : line.trim()).trim();
    if (!text) continue;
    if (lower.includes('alert') || lower.includes('statictext')) return text;
    fallback ??= text;
  }
  return fallback;
}

export async function runDriverLoop(
  browser: BrowserPort,
  router: ModelRouter,
  artifacts: ArtifactStore,
  task: string,
  url: string,
  opts: LoopOptions,
): Promise<Report> {
  const t0 = Date.now();
  const steps: StepRecord[] = [];
  let verdict: RunVerdict = 'uncertain';
  let reason = 'step budget exhausted before the task completed';
  let failingStep: FailingStep | null = null;

  const onStep = opts.onStep ?? (() => {});
  const allowedHosts = opts.allowedHosts ?? ['localhost', '127.0.0.1'];
  const vault = opts.vault;
  const signal = opts.signal;
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const perGoalMaxSteps = opts.perGoalMaxSteps ?? Math.min(maxSteps, DEFAULT_PER_GOAL_STEPS);
  const assertionPolicy = opts.assertionPolicy ?? 'single-ladder';
  const videoAssertions = opts.videoAssertions ?? false;
  // A5b (P1 safety): see LoopOptions.readOnly's doc comment for the default split.
  const readOnly = opts.readOnly ?? false;
  // A5a (P1 safety): undefined/0/negative all mean "no cap" (config.ts/service.ts
  // already normalize a set value to a positive finite number before it gets here).
  const spendCapUsd = opts.spendCapUsd && opts.spendCapUsd > 0 ? opts.spendCapUsd : undefined;
  const assertionTrace: AssertionTraceEntry[] = [];
  const runData = createRunDataState();
  const actionCache = opts.actionCache;
  const actionCacheStats = { enabled: Boolean(actionCache), hits: 0, misses: 0, stale: 0, stored: 0 };

  await browser.navigate(url);
  browser.drainConsole();
  browser.drainNetwork(); // initial page load noise is not step evidence

  let stepIndex = 0; // running index across batches, bounded by maxSteps
  let lastBatchFirstSig: string | null = null; // for loop detection
  let lastSnapshotAx: AxSnapshot | null = null; // last tree text, for the uncertain-reason heuristic
  let done = false;

  // ---- the plan (two-tier split) ----
  // goals: the ordered sub-goal checklist the smart BRAIN makes ONCE up front;
  // currentGoal walks it. The cheap NAVIGATOR drives every step toward
  // goals[currentGoal]; the brain is re-consulted only on stuck (see escalate()).
  let goals: string[] = [];
  let currentGoal = 0;
  let hint: string | undefined; // one-shot brain steer for the next navigator call
  let stepsInGoal = 0; // steps spent on the current goal (per-goal budget)
  // Bounds brain cost when the navigator can't recover: N consecutive escalations
  // that yield no navigator progress → end honestly instead of looping forever.
  let brainEscalations = 0;
  // Whether a BRAIN (plan-goals) adapter is configured at all. Set from the router
  // just before the initial plan. When false the run degrades to navigator-only:
  // one implicit goal = the task, and escalate() ends honestly (no brain to ask).
  let brainAvailable = true;

  /* Escalate to the BRAIN with a failure reason and apply its answer:
   *  - a final verdict → end the run with it;
   *  - replacement goals (completed ones kept) → keep navigating the new plan;
   *  - a hint → feed it to the next navigator call;
   *  - nothing useful, or the escalation cap is hit → end honestly (uncertain).
   * Returns 'continue' to keep the outer loop going, 'end' to stop it. */
  const escalate = async (failure: string): Promise<'continue' | 'end'> => {
    if (signal?.aborted) {
      reason = 'cancelled by user';
      return 'end';
    }
    // navigator-only mode (no brain configured): there is nobody to ask — end
    // honestly with the failure reason (mirrors the old single-model behaviour).
    if (!brainAvailable) {
      const visibleErr = visibleErrorText(lastSnapshotAx?.text);
      verdict = 'uncertain';
      reason =
        `stuck: ${failure}` +
        (visibleErr ? ` — page shows: "${visibleErr}" (likely the real cause)` : '');
      return 'end';
    }
    if (brainEscalations >= MAX_BRAIN_ESCALATIONS) {
      const visibleErr = visibleErrorText(lastSnapshotAx?.text);
      verdict = 'uncertain';
      reason =
        `stuck: ${failure}` +
        (visibleErr ? ` — page shows: "${visibleErr}" (likely the real cause)` : '') +
        ' — the planner could not recover';
      return 'end';
    }
    brainEscalations++;
    const ax = await browser.axTree();
    lastSnapshotAx = ax;
    const nowUrl = await browser.url();
    onStep({ index: stepIndex, kind: 'plan', text: `Stuck — asking the planner: ${failure.slice(0, 80)}` });
    let gp: GoalPlan;
    try {
      gp = await planGoalsOnce(router, {
        prompt: buildGoalPlannerPrompt({
          task,
          url: nowUrl,
          axText: ax.text,
          history: steps,
          goals,
          currentGoal,
          failure,
        }),
        step: stepIndex,
      });
    } catch (e) {
      verdict = 'uncertain';
      reason = `planner failed while recovering from "${failure}": ${e instanceof Error ? e.message : e}`;
      return 'end';
    }
    // a final verdict from the brain ends the run
    if (gp.verdict) {
      verdict = gp.verdict;
      reason = gp.reason ?? failure;
      if (verdict === 'fail' && !failingStep) failingStep = lastInteraction(steps);
      return 'end';
    }
    // replacement goals: keep the ones already completed, swap the rest
    if (gp.goals && gp.goals.length) {
      goals = [...goals.slice(0, currentGoal), ...gp.goals];
      hint = gp.hint;
      stepsInGoal = 0;
      lastBatchFirstSig = null; // fresh plan — don't trip loop-detection on stale history
      onStep({
        index: stepIndex,
        kind: 'plan',
        text: `Re-planned ${gp.goals.length} goal${gp.goals.length === 1 ? '' : 's'}: ${gp.goals.join(' → ').slice(0, 140)}`,
      });
      return 'continue';
    }
    // just a hint for the next navigator call
    if (gp.hint) {
      hint = gp.hint;
      lastBatchFirstSig = null;
      onStep({ index: stepIndex, kind: 'plan', text: `Planner hint: ${gp.hint.slice(0, 100)}` });
      return 'continue';
    }
    // the brain offered nothing actionable — end honestly
    verdict = 'uncertain';
    reason = `stuck: ${failure} — the planner offered no new plan`;
    return 'end';
  };

  /* Confirm a claimed pass with ONE visual check over the current page and record
   * it on `record`. pass → verdict pass; disagree/uncertain → let the BRAIN make
   * the final call (cheap-then-smart). Returns escalate()'s outcome in that case. */
  const confirmPass = async (
    i: number,
    record: StepRecord,
    reasonText: string,
  ): Promise<'pass' | 'end' | 'continue'> => {
    const png = await browser.screenshot();
    record.screenshot = artifacts.saveScreenshot(i, png);
    const confirm = await runVisualAssertion(
      router,
      png,
      `The task "${task}" should have completed successfully. Does the page show a sensible end state for it (no error banners, no blank page)?`,
      i,
      assertionPolicy,
    );
    assertionTrace.push(confirm.trace);
    record.visual = confirm.verdict;
    if (confirm.verdict.verdict === 'pass') {
      verdict = 'pass';
      reason = reasonText;
      return 'pass';
    }
    // navigator-only mode: no brain to arbitrate — honour the visual directly (a
    // failing confirmation = a broken end state), exactly as the old loop did.
    if (!brainAvailable) {
      verdict = confirm.verdict.verdict === 'fail' ? 'fail' : 'uncertain';
      reason =
        `navigator declared success but the confirmation visual was ${confirm.verdict.verdict}: ${confirm.verdict.summary}` +
        (confirm.verdict.issues.length ? ` — ${confirm.verdict.issues.join('; ')}` : '');
      if (verdict === 'fail') failingStep = { index: i, action: record.action, description: record.description };
      return 'end';
    }
    // navigator claimed success but the visual disagrees/uncertain — brain decides
    return escalate(
      `navigator declared success but the confirmation visual was ${confirm.verdict.verdict}: ${confirm.verdict.summary}` +
        (confirm.verdict.issues.length ? ` — ${confirm.verdict.issues.join('; ')}` : ''),
    );
  };

  /* The navigator believes every goal is met → synthesize a finish:pass step and
   * confirm it. Shared by the goalComplete-past-last path and the safety guard. */
  const runFinishPass = async (reasonText: string): Promise<'pass' | 'end' | 'continue'> => {
    const i = stepIndex++;
    stepsInGoal++;
    const action: Action = { type: 'finish', verdict: 'pass', reason: reasonText };
    const record: StepRecord = {
      index: i,
      action,
      description: describeAction(action),
      ok: true,
      console: [],
      network: [],
      ts: Date.now(),
    };
    steps.push(record);
    let outcome: 'pass' | 'end' | 'continue';
    try {
      outcome = await confirmPass(i, record, reasonText);
    } catch (e) {
      record.ok = false;
      record.error = e instanceof Error ? e.message : String(e);
      verdict = 'uncertain';
      reason = `could not confirm success: ${record.error}`;
      outcome = 'end';
    }
    await sleep(150);
    record.console = browser.drainConsole();
    record.network = browser.drainNetwork();
    artifacts.appendAudit({
      ts: record.ts,
      runId: artifacts.runId,
      action: action.type,
      target: undefined,
      url: await browser.url(),
      ok: record.ok,
    });
    onStep({ index: i, kind: stepKind(action), text: humanizeAction(action), ok: record.ok });
    return outcome;
  };

  // ---- initial plan (BRAIN, 1 call) — or navigator-only when no brain configured ----
  brainAvailable = await router.hasCapability('plan-goals');
  if (!brainAvailable) {
    // no smart planner on the ladder (a single-model setup, or a navigator-only
    // config): run one implicit goal = the whole task; the navigator drives it and
    // escalate() ends honestly on stuck. This is the old single-model behaviour.
    goals = [task];
    onStep({ index: stepIndex, kind: 'plan', text: 'No planner configured — navigating directly.' });
  } else {
    const ax = await browser.axTree();
    lastSnapshotAx = ax;
    const planUrl = await browser.url();
    onStep({ index: stepIndex, kind: 'plan', text: 'Planning goals…' });
    try {
      const goalPlan = await planGoalsOnce(router, {
        prompt: buildGoalPlannerPrompt({ task, url: planUrl, axText: ax.text }),
        step: stepIndex,
      });
      if (goalPlan.verdict) {
        // the brain reached a verdict from the first look — honour it
        verdict = goalPlan.verdict;
        reason = goalPlan.reason ?? `planner decided ${goalPlan.verdict} before any steps were needed`;
        if (verdict === 'fail') failingStep = lastInteraction(steps);
        done = true;
      } else if (goalPlan.goals && goalPlan.goals.length) {
        goals = goalPlan.goals;
        onStep({
          index: stepIndex,
          kind: 'plan',
          text: `Planned ${goals.length} goal${goals.length === 1 ? '' : 's'}: ${goals.join(' → ').slice(0, 160)}`,
        });
      } else {
        reason = 'planner returned no goals to execute';
        done = true;
      }
    } catch (e) {
      // the brain was advertised but failed on the first call — degrade to
      // navigator-only rather than abort the whole run.
      brainAvailable = false;
      goals = [task];
      onStep({
        index: stepIndex,
        kind: 'plan',
        text: `Planner unavailable (${e instanceof Error ? e.message.slice(0, 60) : e}) — navigating directly.`,
      });
    }
  }

  // each outer iteration = ONE navigator call → a batch of 1-3 actions (or a
  // meta-output: goalComplete / blocked) toward the current goal.
  while (stepIndex < maxSteps && !done) {
    if (signal?.aborted) {
      reason = 'cancelled by user';
      break;
    }

    // ---- A5a: spend cap — checked once per outer iteration (i.e. once per
    // navigator call / brain escalation), so it gates the next expensive call
    // before it's made rather than mid-call. ----
    if (spendCapUsd !== undefined) {
      const spentUsd = estimatedPaidSpendUsd(router.trace);
      if (spentUsd >= spendCapUsd) {
        verdict = 'uncertain';
        reason =
          `spend cap reached: estimated spend ~$${spentUsd.toFixed(4)} has reached the configured ` +
          `$${spendCapUsd} cap (proxy: paid model-call token total × ~$${SPEND_PROXY_USD_PER_MILLION_TOKENS}` +
          '/1M tokens — see LoopOptions.spendCapUsd; not exact billing)';
        break;
      }
    }

    // all goals consumed but no finish yet — treat as a pass candidate (safety net)
    if (currentGoal >= goals.length) {
      const outcome = await runFinishPass(`all ${goals.length} goals completed`);
      if (outcome === 'continue') continue;
      break;
    }

    const ax = await browser.axTree();
    lastSnapshotAx = ax;
    const batchUrl = await browser.url();

    if (actionCache && stepIndex < maxSteps) {
      const cachedRecords = actionCache.findForContext({ url: batchUrl, goal: goals[currentGoal], page: ax });
      if (cachedRecords.length === 0) actionCacheStats.misses++;
      let acceptedCacheHit = false;
      const recordsToTry = cachedRecords.length === 1 ? cachedRecords : [];
      if (cachedRecords.length > 1) actionCacheStats.misses++;
      for (const cached of recordsToTry) {
        const cachedAction = await actionFromCachedValue(cached.value, ax, browser);
        if (!cachedAction || cachedAction.type === 'assert_visual' || cachedAction.type === 'finish' || cachedAction.type === 'wait') {
          actionCacheStats.stale++;
          continue;
        }
        const i = stepIndex++;
        stepsInGoal++;
        const target = cachedTargetForRecord(cached.value);
        const record: StepRecord = {
          index: i,
          thought: 'cached action',
          action: cachedAction,
          description: `cached: ${describeAction(cachedAction)}`,
          ...(target && { target }),
          ok: true,
          console: [],
          network: [],
          ts: Date.now(),
        };
        steps.push(record);
        try {
          const before = await captureActionEffectState(browser);
          await executeCacheAction(browser, cachedAction, ax.root, runData, vault);
          await sleep(150);
          const after = await captureActionEffectState(browser);
          const effect = verifyActionEffect(before, after, cachedAction, target);
          if (!effect.ok) {
            record.ok = false;
            record.error = `stale cached action: ${effect.reason}`;
            actionCacheStats.stale++;
            actionCache.delete(cached.key);
          } else {
            actionCacheStats.hits++;
            actionCache.markHit(cached);
            acceptedCacheHit = true;
          }
        } catch (e) {
          record.ok = false;
          record.error = e instanceof Error ? e.message : String(e);
          actionCacheStats.stale++;
          actionCache.delete(cached.key);
        }
        record.console = browser.drainConsole();
        record.network = browser.drainNetwork();
        artifacts.appendAudit({
          ts: record.ts,
          runId: artifacts.runId,
          action: cachedAction.type,
          target: auditTarget(cachedAction, record.target),
          url: await browser.url(),
          ok: record.ok,
        });
        onStep({
          index: i,
          kind: stepKind(cachedAction),
          text: record.ok ? `Cached ${humanizeAction(cachedAction, record.target)}` : `Stale cache: ${humanizeAction(cachedAction, record.target)}`,
          ok: record.ok,
        });
        if (acceptedCacheHit) break;
      }
      if (acceptedCacheHit) continue;
    }

    // ---- navigate (cheap NAVIGATOR: one call per step) ----
    onStep({
      index: stepIndex,
      kind: 'plan',
      text: `Planning next step (goal ${currentGoal + 1}/${goals.length})…`,
    });
    let plan: PlanResult;
    try {
      plan = await navigateOnce(router, {
        prompt: buildNavigatorPrompt({
          task,
          url: batchUrl,
          axText: ax.text,
          goal: goals[currentGoal],
          goals,
          currentGoal,
          history: steps,
          stepIndex,
          maxSteps,
          hint,
        }),
        step: stepIndex,
      });
    } catch (e) {
      // invalid navigator JSON twice (or adapter failure) → ask the brain
      const outcome = await escalate(`navigator failed: ${e instanceof Error ? e.message : e}`);
      if (outcome === 'end') break;
      continue;
    }

    // ---- navigator meta-outputs (see PlanResultSchema) ----
    if (plan.blocked) {
      const outcome = await escalate(`navigator blocked: ${plan.blocked}`);
      if (outcome === 'end') break;
      continue;
    }
    if (plan.goalComplete) {
      currentGoal++;
      hint = undefined;
      stepsInGoal = 0;
      brainEscalations = 0; // completing a goal is progress
      if (currentGoal >= goals.length) {
        const outcome = await runFinishPass(`completed all ${goals.length} goals`);
        if (outcome === 'continue') continue;
        break;
      }
      onStep({ index: stepIndex, kind: 'plan', text: `Goal done → next: ${goals[currentGoal].slice(0, 100)}` });
      continue;
    }

    let actions = plan.actions;
    if (!actions || actions.length === 0) {
      // neither actions nor a meta-output we could act on — ask the brain
      const outcome = await escalate('navigator returned neither actions nor a goal outcome');
      if (outcome === 'end') break;
      continue;
    }
    // finish / asserts / script must be alone in their batch — if the model
    // bundled extras, keep only the first action (these never batch)
    if (
      actions[0].type === 'finish' ||
      actions[0].type === 'assert_visual' ||
      actions[0].type === 'assert_dom' ||
      actions[0].type === 'script'
    ) {
      actions = [actions[0]];
    }

    // ---- loop detection → escalate FIRST (was: end the run) ----
    // compare the FIRST action of consecutive identical single-action batches.
    const firstSig = actions.length === 1 ? JSON.stringify(actions[0]) : null;
    if (
      firstSig !== null &&
      firstSig === lastBatchFirstSig &&
      steps.length >= 2 &&
      JSON.stringify(steps[steps.length - 1].action) === firstSig &&
      JSON.stringify(steps[steps.length - 2].action) === firstSig
    ) {
      const visibleErr = visibleErrorText(lastSnapshotAx?.text);
      const outcome = await escalate(
        `navigator repeated the same action 3×: ${describeAction(actions[0])}` +
          (visibleErr ? ` — page shows: "${visibleErr}" (likely the real cause)` : ''),
      );
      if (outcome === 'end') break;
      lastBatchFirstSig = null; // brain re-planned — reset the loop signature
      continue;
    }
    lastBatchFirstSig = firstSig;

    // ---- execute the batch, one StepRecord + drain per action ----
    let aborted = false;
    let readOnlyBlock: string | null = null; // set when a mutation hits a non-allowed host
    let finishReplan = false; // brain overruled a premature finish:pass → keep going
    for (let a = 0; a < actions.length && stepIndex < maxSteps; a++) {
      const action = actions[a];

      if (signal?.aborted) {
        aborted = true;
        reason = 'cancelled by user';
        break;
      }

      // ---- Tier-4 guard: mutations only on allowed hosts. Check the LIVE page
      // host, not batchUrl — an earlier action in the batch may have navigated us
      // elsewhere. navigate/assert/wait stay allowed. (A5b's read-only guard,
      // below, is a SEPARATE layer on top of this one — not a replacement.)
      if (isMutatingAction(action)) {
        const host = hostOf(await browser.url());
        if (host && !hostAllowed(host, allowedHosts)) {
          readOnlyBlock = host;
          break;
        }
      }

      const i = stepIndex++;
      stepsInGoal++;

      const record: StepRecord = {
        index: i,
        thought: a === 0 ? plan.thought : undefined,
        action,
        description: describeAction(action),
        ok: true,
        console: [],
        network: [],
        ts: Date.now(),
      };
      // remember WHAT the action touches (role+name) — this is what makes the
      // run replayable later; nodeIds die with the snapshot. `extract`'s nodeId
      // is optional (Phase 15 model-assisted mode may target the whole page) —
      // the typeof guard both narrows action.nodeId to `string` and correctly
      // skips a nodeId-less extract.
      if ('nodeId' in action && typeof action.nodeId === 'string') {
        const t = findNode(ax.root, action.nodeId);
        if (t) {
          record.target = { role: t.role, ...(t.name && { name: t.name }) };
          // #6: when the snapshot held >1 node sharing this role+name, record
          // which one (0-based, document order) so replay/codegen can disambiguate.
          const { count, index } = rankByRoleName(ax.root, t.role, t.name, action.nodeId);
          if (count > 1 && index >= 0) record.target.nth = index;
          // #9: a name-less interaction target has no resilient role+name locator
          // — stamp a data-qa-id as a fallback (best-effort; lost on reload).
          if (!readOnly && !t.name && (action.type === 'click' || action.type === 'type' || action.type === 'hover' || action.type === 'select_option') && browser.stampQaId) {
            try {
              const qaId = await browser.stampQaId(action.nodeId);
              if (qaId) record.target.qaId = qaId;
            } catch {
              /* best-effort: a stamp failure must not fail the step */
            }
          }
        }
      } else if (action.type === 'drag_and_drop') {
        // drag_and_drop has TWO targets (sourceId/targetId) — StepRecord.target
        // only has one slot, so we record the SOURCE there (matches the
        // click/hover convention: the node you act FROM) and resolve BOTH as
        // sourceTarget/targetTarget on the action itself (never model-emitted —
        // see actions.ts) so the recorder can distill a full replay step
        // without needing a second target slot on StepRecord.
        const src = findNode(ax.root, action.sourceId);
        const dst = findNode(ax.root, action.targetId);
        if (src) {
          record.target = { role: src.role, ...(src.name && { name: src.name }) };
          const srcRank = rankByRoleName(ax.root, src.role, src.name, action.sourceId);
          if (srcRank.count > 1 && srcRank.index >= 0) record.target.nth = srcRank.index;
        }
        const sourceTarget = src
          ? { role: src.role, ...(src.name && { name: src.name }), ...(record.target?.nth !== undefined && { nth: record.target.nth }) }
          : undefined;
        let targetTarget: { role: string; name?: string; nth?: number } | undefined;
        if (dst) {
          const dstRank = rankByRoleName(ax.root, dst.role, dst.name, action.targetId);
          targetTarget = {
            role: dst.role,
            ...(dst.name && { name: dst.name }),
            ...(dstRank.count > 1 && dstRank.index >= 0 && { nth: dstRank.index }),
          };
        }
        if (sourceTarget || targetTarget) {
          record.action = { ...action, ...(sourceTarget && { sourceTarget }), ...(targetTarget && { targetTarget }) };
        }
      }
      steps.push(record);

      // ---- execute ----
      const cacheBefore =
        actionCache && a === actions.length - 1 && action.type !== 'finish' && action.type !== 'assert_visual' && action.type !== 'wait'
          ? await captureActionEffectState(browser).catch(() => null)
          : null;
      // one `browser.action` telemetry span per executed action (no-op sink by
      // default). Attributes are non-secret (type/step/kind only — never type
      // text, urls beyond host, or targets); redaction is a second safety net.
      const actionSpan = getDefaultTracer().startSpan('browser.action', {
        type: action.type,
        step: i,
        ...(action.type === 'mouse' && { kind: action.kind }),
      });
      // A5b: dry-run/read-only mode — refuse the action outright instead of
      // executing it. ONE guard, right at the top of the dispatch, so every
      // downstream step (span/drain/audit/onStep/batch-abort/progress-tracking
      // below) sees a normal-shaped, already-"succeeded" step and needs no
      // special-casing of its own.
      let skippedReadOnly = false;
      try {
        if (readOnly && isMutatingAction(action)) {
          skippedReadOnly = true;
          record.ok = true;
          record.description = `read-only mode: skipped ${record.description}`;
        } else if (action.type === 'finish') {
          // trust a fail immediately; confirm a pass with one visual check
          if (action.verdict === 'fail') {
            verdict = 'fail';
            reason = action.reason;
            failingStep = lastInteraction(steps) ?? { index: i, action, description: record.description };
          } else {
            const outcome = await confirmPass(i, record, action.reason);
            // 'pass'/'end' → verdict settled, run ends; 'continue' → brain re-planned
            if (outcome === 'continue') finishReplan = true;
          }
        } else if (action.type === 'assert_visual') {
          const wantsVideo = action.mode === 'video';
          const videoRecorder =
            wantsVideo && browser.cdpClient
              ? await startAssertionClip(browser.cdpClient(), artifacts)
              : null;
          if (videoRecorder) await sleep(500);
          const png = await browser.screenshot();
          record.screenshot = artifacts.saveScreenshot(i, png);
          const videoPath = videoRecorder ? await videoRecorder.stop().catch(() => null) : null;
          if (videoPath) record.video = videoPath;

          // Phase 8: route a video-mode assertion to a REAL video verdict only
          // when the (costly, opt-in) videoAssertions flag is on AND a clip was
          // captured AND the ladder actually has a video-capable adapter. Any
          // failure here — including the capability probe — falls back to the
          // existing screenshot verdict path below (graceful degrade, never a
          // hard failure just because video judging didn't work out).
          let v: AssertionResult | null = null;
          if (wantsVideo && videoAssertions && videoPath) {
            try {
              if (await router.hasVideoVerdict()) {
                const videoVerdict = await router.videoVerdict(videoPath, action.expectation, i);
                v = {
                  verdict: videoVerdict,
                  trace: {
                    step: i,
                    policy: assertionPolicy,
                    expectation: action.expectation,
                    verdict: videoVerdict.verdict,
                    summary: `[video] ${videoVerdict.summary}`,
                    disagreement: false,
                  },
                };
              }
            } catch {
              v = null; // graceful fallback to the screenshot verdict below
            }
          } else if (wantsVideo && !videoAssertions) {
            record.description += ' (video assertion requested but disabled — screenshot fallback)';
          }
          if (!v) {
            v = await runVisualAssertion(router, png, action.expectation, i, assertionPolicy);
          }
          assertionTrace.push(v.trace);
          record.visual = v.verdict;
          if (v.verdict.verdict === 'fail') {
            verdict = 'fail';
            reason = `visual assertion failed: ${v.verdict.summary}${v.verdict.issues.length ? ` - ${v.verdict.issues.join('; ')}` : ''}`;
            failingStep = { index: i, action, description: record.description };
          }
        } else if (action.type === 'assert_dom') {
          const t = findNode(ax.root, action.nodeId);
          const hay = t ? subtreeText(t) : '';
          if (!t) {
            record.ok = false;
            record.error = `nodeId ${action.nodeId} not in current tree`;
          } else if (!hay.toLowerCase().includes(action.contains.toLowerCase())) {
            record.ok = false;
            record.error = `expected ${JSON.stringify(action.contains)} in ${action.nodeId}, found: ${hay.slice(0, 150)}`;
          }
        } else if (action.type === 'type') {
          // resolve {{secret:NAME}} AT EXECUTE TIME ONLY — the record keeps the
          // PLACEHOLDER (action is unchanged), so history/report/recorder/audit
          // never hold the real value. Missing secret → step fails.
          const resolvedRun = resolveRunPlaceholders(action.text, runData).text;
          const resolved = resolveSecrets(resolvedRun, vault);
          await executeWithRetry(browser, { ...action, text: resolved }, ax.root);
        } else if (action.type === 'extract') {
          if (action.prompt) {
            // Phase 15 — model-assisted extraction: TEXT-only, via the SAME
            // plan-step-capable adapter the navigator already uses
            // (router.planJson) — no vision call, no new router surface.
            // nodeId optional: absent → search the whole serialized page text.
            const source = action.nodeId ? findNode(ax.root, action.nodeId) : undefined;
            if (action.nodeId && !source) {
              record.ok = false;
              record.error = `nodeId ${action.nodeId} not in current tree`;
            } else {
              const text = source ? subtreeText(source).trim() : ax.text;
              try {
                const raw = await router.planJson(
                  buildExtractPrompt({ prompt: action.prompt, key: action.key, text }),
                  EXTRACT_JSON_SCHEMA,
                  i,
                );
                const parsed = ExtractResultSchema.safeParse(raw);
                const value = parsed.success ? parsed.data.value : null;
                if (!value) {
                  record.ok = false;
                  record.error = `model extraction found no value for ${action.key}`;
                } else {
                  // never persist secrets — extracted values follow the same
                  // non-secret run-data rules as any other {{run.*}} value.
                  recordExtraction(runData, { key: action.key, value, source: 'model', label: record.target?.name });
                }
              } catch (e) {
                record.ok = false;
                record.error = `model extraction failed: ${e instanceof Error ? e.message : String(e)}`;
              }
            }
          } else if (!action.nodeId) {
            record.ok = false;
            record.error = 'extract without a prompt requires nodeId';
          } else {
            const t = findNode(ax.root, action.nodeId);
            if (!t) {
              record.ok = false;
              record.error = `nodeId ${action.nodeId} not in current tree`;
            } else {
              const hay = subtreeText(t).trim();
              const value = extractValue(hay, action.pattern);
              if (!value) {
                record.ok = false;
                record.error = `could not extract ${action.key} from ${action.nodeId}`;
              } else {
                recordExtraction(runData, { key: action.key, value, source: 'dom', label: record.target?.name });
              }
            }
          }
        } else if (action.type === 'drag_and_drop') {
          await browser.dragAndDrop(action.sourceId, action.targetId);
        } else if (action.type === 'open_tab') {
          const tabId = await browser.openTab(action.url);
          // reuse the single StepTarget slot to carry the runtime tab id — the
          // recorder correlates later switch_tab/close_tab steps against it.
          record.target = { role: 'tab', name: tabId };
        } else if (action.type === 'switch_tab') {
          await browser.switchTab(action.tabId);
          record.target = { role: 'tab', name: action.tabId };
        } else if (action.type === 'close_tab') {
          await browser.closeTab(action.tabId);
          record.target = { role: 'tab', name: action.tabId };
        } else if (action.type === 'script') {
          // Phase 10 — secure script runner: VALIDATE before executing anything;
          // a rejected script never runs a single step. A validation/execution
          // failure surfaces as a normal failed step — the navigator sees it in
          // history next call and the existing stuck machinery (repeated action,
          // blocked, per-goal overflow) escalates to the brain if it persists.
          const validated = validateScriptSteps(action.steps);
          if (!validated.ok) {
            record.ok = false;
            record.error = `script rejected: ${validated.reason}`;
          } else {
            const result = await runScriptSteps(browser, validated.steps, runData, vault);
            if (!result.ok) {
              record.ok = false;
              record.error = `script failed after ${result.executedSteps} step(s): ${result.error}`;
            }
          }
        } else {
          await executeWithRetry(browser, action, ax.root);
        }
      } catch (e) {
        if (e instanceof RunDataNotFoundError) {
          record.ok = false;
          record.error = `run data "${e.key}" not found`;
        } else {
          record.ok = false;
          record.error = e instanceof Error ? e.message : String(e);
        }
      }
      if (record.ok === false) actionSpan.fail(record.error ?? 'action failed');
      else actionSpan.end();

      await sleep(150); // let async fallout (fetches, navigations) land
      record.console = browser.drainConsole();
      record.network = browser.drainNetwork();

      if (actionCache && cacheBefore && record.ok && !skippedReadOnly) {
        try {
          const cacheAfter = await captureActionEffectState(browser);
          const effect = verifyActionEffect(cacheBefore, cacheAfter, action, record.target);
          if (effect.ok) {
            const key = buildActionCacheKey({
              url: batchUrl,
              goal: goals[currentGoal] ?? task,
              action,
              page: ax,
              target: record.target,
            });
            const value = toCachedActionValue(action, record.target);
            actionCache.put(key, value, { sourceRunId: artifacts.runId, sourceStepIndex: record.index });
            actionCacheStats.stored++;
          }
        } catch (e) {
          if (!(e instanceof ActionCacheRejectedError)) {
            /* cache write failures must not fail a QA step */
          }
        }
      }

      // ---- audit trail: one redacted JSON line per EXECUTED action. target is
      // role+name or url (placeholders, never resolved secrets). ----
      artifacts.appendAudit({
        ts: record.ts,
        runId: artifacts.runId,
        action: action.type,
        target: auditTarget(action, record.target),
        url: await browser.url(),
        ok: record.ok,
      });

      onStep({
        index: i,
        kind: stepKind(action),
        // record.action may have been re-shaped post-resolution (e.g.
        // drag_and_drop gains sourceTarget/targetTarget) — humanize THAT so the
        // progress line can show the resolved drop-target name. A5b: prefix the
        // same "read-only mode: skipped" label the step record carries.
        text: skippedReadOnly
          ? `read-only mode: skipped ${humanizeAction(record.action, record.target)}`
          : humanizeAction(record.action, record.target),
        ok: record.ok,
      });

      // a real action that landed = navigator progress; reset the stuck counter.
      // A5b: a read-only-skipped action did NOT actually land — don't count it,
      // so a navigator that keeps proposing the same blocked mutation still
      // trips loop-detection / per-goal-overflow and escalates normally.
      if (
        record.ok &&
        !skippedReadOnly &&
        (
          action.type === 'click' ||
          action.type === 'type' ||
          action.type === 'hover' ||
          action.type === 'press_key' ||
          action.type === 'select_option' ||
          action.type === 'navigate' ||
          action.type === 'reload' ||
          action.type === 'go_back' ||
          action.type === 'upload_file' ||
          action.type === 'drag_and_drop' ||
          action.type === 'blur' ||
          action.type === 'mouse' ||
          action.type === 'open_tab' ||
          action.type === 'switch_tab' ||
          action.type === 'close_tab' ||
          action.type === 'script'
        )
      ) {
        brainEscalations = 0;
      }

      // a finish or a settled verdict ends the whole run — UNLESS the brain
      // overruled a premature finish:pass, in which case we keep navigating.
      if (verdict !== 'uncertain' || action.type === 'finish') {
        if (finishReplan) break; // out of the batch; outer loop continues (done stays false)
        done = true;
        break;
      }

      // ---- batch abort conditions: stop running the REST of the batch when
      // an action failed, a drain shows a page-error, or the URL changed ----
      if (a < actions.length - 1) {
        if (!record.ok) break;
        if (drainHasPageError(record.console, record.network)) break;
        // navigate-like actions AND a tab switch end the batch — the a11y tree
        // captured at batch start (`ax`) no longer describes the active page.
        if (
          action.type === 'navigate' ||
          action.type === 'reload' ||
          action.type === 'go_back' ||
          action.type === 'switch_tab'
        ) {
          break;
        }
        const nowUrl = await browser.url();
        if (nowUrl !== batchUrl) break;
      }
    }

    // cancellation / read-only guard end the whole run immediately (the guard
    // must NOT burn the step budget — finish 'uncertain' citing the host).
    if (aborted) {
      break; // reason already set to 'cancelled by user'
    }
    if (readOnlyBlock) {
      verdict = 'uncertain';
      reason =
        `read-only mode: ${readOnlyBlock} is not in allowedHosts — ` +
        'add it via QA_ALLOWED_HOSTS or qa.config.json to allow interaction';
      break;
    }

    // ---- per-goal budget: a goal grinding on without completing → ask the brain ----
    if (!done && !finishReplan && stepsInGoal >= perGoalMaxSteps) {
      const outcome = await escalate(`goal "${goals[currentGoal]}" ran ${stepsInGoal} steps without completing`);
      if (outcome === 'end') break;
      stepsInGoal = 0; // fresh budget for the (possibly re-planned) goal
    }
  }

  // ---- final evidence ----
  const lastStep = steps[steps.length - 1];
  if (lastStep && !lastStep.screenshot) {
    try {
      const png = await browser.screenshot();
      lastStep.screenshot = artifacts.saveScreenshot(lastStep.index, png);
    } catch {
      /* page may be gone */
    }
  }
  if (verdict === 'fail' && !failingStep && lastStep) {
    failingStep = { index: lastStep.index, action: lastStep.action, description: lastStep.description };
  }

  // first error-shaped evidence, scanning from the failing step backwards
  let consoleError: string | null = null;
  const scanOrder = failingStep
    ? [...steps.slice(0, failingStep.index + 1)].reverse()
    : [...steps].reverse();
  for (const s of scanOrder) {
    const err = firstError(s.console, s.network);
    if (err) {
      consoleError = err;
      break;
    }
  }

  const report: Report = {
    verdict,
    failing_step: failingStep,
    console_error: consoleError,
    evidence_paths: [],
    reason,
    runId: artifacts.runId,
    task,
    url,
    steps,
    model_trace: router.trace,
    assertion_trace: assertionTrace,
    run_data: runData,
    action_cache: actionCacheStats,
    durationMs: Date.now() - t0,
    tokenEstimate: 0,
    tokens: {
      cheapModelTotal: 0,
      cheapModelCached: 0,
      callsByRung: {},
      verdictPayloadTokens: 0,
      navigatorCalls: 0,
      brainCalls: 0,
      visualCalls: 0,
      navigatorTokens: 0,
      brainTokens: 0,
    },
  };
  report.evidence_paths = [
    ...steps.filter((s) => s.screenshot).map((s) => s.screenshot!),
    ...steps.filter((s) => s.video).map((s) => s.video!),
  ];
  const reportPath = artifacts.saveReport(report);
  report.evidence_paths.unshift(reportPath);
  // A5a: attach the compact spend summary BEFORE counting tokens — it is part of
  // the slim payload the caller reads back, so verdictPayloadTokens must include
  // it (see report.ts's SpendSummary doc comment).
  report.spendSummary = computeSpendSummary(report, spendCapUsd);
  const tokens = computeTokens(report);
  report.tokens = tokens;
  // tokenEstimate keeps its product-doc meaning: what the calling agent pays.
  report.tokenEstimate = tokens.verdictPayloadTokens;
  artifacts.saveReport(report); // rewrite with final paths + estimate
  return report;
}

/** Real token accounting. cheapModel* sum the measured per-call usage in the
 * trace (the FREE/cheap-rung spend doing the looking); callsByRung counts every
 * model call (rung 0 = $0 on-device Nano, whose tokens are irrelevant);
 * verdictPayloadTokens = the slim 5-field report the EXPENSIVE caller reads back
 * (~chars/4) — what the calling agent actually pays.
 *
 * Per-role split (the proof the two-tier architecture works): group the trace by
 * `capability` — plan-step → navigator (cheap, every step), plan-goals → brain
 * (smart, rare), visual-verdict → visual. brainCalls must NOT scale with steps. */
function computeTokens(r: Report): NonNullable<Report['tokens']> {
  let cheapModelTotal = 0;
  let cheapModelCached = 0;
  const callsByRung: Record<number, number> = {};
  let navigatorCalls = 0;
  let brainCalls = 0;
  let visualCalls = 0;
  let navigatorTokens = 0;
  let brainTokens = 0;
  for (const t of r.model_trace) {
    callsByRung[t.rung] = (callsByRung[t.rung] ?? 0) + 1;
    if (t.usage?.totalTokens) cheapModelTotal += t.usage.totalTokens;
    if (t.usage?.cachedTokens) cheapModelCached += t.usage.cachedTokens;
    // per-role split by capability
    if (t.capability === 'plan-step') {
      navigatorCalls++;
      if (t.usage?.totalTokens) navigatorTokens += t.usage.totalTokens;
    } else if (t.capability === 'plan-goals') {
      brainCalls++;
      if (t.usage?.totalTokens) brainTokens += t.usage.totalTokens;
    } else if (t.capability === 'visual-verdict') {
      visualCalls++;
    }
  }
  // count the ACTUAL slim payload the caller reads back (slimReport), so this
  // never drifts from what report.ts serializes (e.g. when spendSummary was added).
  const verdictPayloadTokens = Math.ceil(
    JSON.stringify(r.steps.length ? slimReport(r) : {}).length / 4,
  );
  return {
    cheapModelTotal,
    cheapModelCached,
    callsByRung,
    verdictPayloadTokens,
    navigatorCalls,
    brainCalls,
    visualCalls,
    navigatorTokens,
    brainTokens,
  };
}

/** A5a (P1): crude USD-per-token conversion for the spend cap proxy. Precise
 * USD isn't derivable here — the router doesn't carry per-adapter pricing, and
 * real rates vary widely by provider/model/tier. This applies a single blended
 * rate to every non-$0 (rung >= 1) call's total tokens — a mid-range paid-model
 * ballpark, deliberately conservative (more likely to OVER- than
 * UNDER-estimate a cheap-tier call's true cost) so the cap errs toward
 * stopping a run too early rather than too late. Replace with real
 * per-adapter pricing if/when the router exposes it. */
const SPEND_PROXY_USD_PER_MILLION_TOKENS = 3;

/** Best-available USD spend proxy from a model_trace-shaped array: sum the
 * token usage of every call NOT on rung 0 (rung 0 = $0 on-device Nano) and
 * apply SPEND_PROXY_USD_PER_MILLION_TOKENS. Used both live (mid-run, against
 * router.trace, to enforce LoopOptions.spendCapUsd) and post-hoc (against the
 * finished report, for the spend summary). */
function estimatedPaidSpendUsd(trace: readonly { rung: number; usage?: { totalTokens?: number } }[]): number {
  let paidTokens = 0;
  for (const t of trace) {
    if (t.rung === 0) continue; // rung 0 = $0 on-device Nano — excluded from the proxy
    if (t.usage?.totalTokens) paidTokens += t.usage.totalTokens;
  }
  return (paidTokens / 1_000_000) * SPEND_PROXY_USD_PER_MILLION_TOKENS;
}

/** A5a (P1): compact spend summary for the done/slim payload (see report.ts's
 * SpendSummary doc comment for field meanings and the estimatedUsd caveat). */
function computeSpendSummary(r: Report, capUsd: number | undefined): SpendSummary {
  let freeCalls = 0;
  let paidCalls = 0;
  let totalTokens = 0;
  for (const t of r.model_trace) {
    if (t.rung === 0) freeCalls++;
    else paidCalls++;
    if (t.usage?.totalTokens) totalTokens += t.usage.totalTokens;
  }
  return {
    freeCalls,
    paidCalls,
    totalTokens,
    estimatedUsd: estimatedPaidSpendUsd(r.model_trace),
    ...(capUsd !== undefined && { capUsd }),
  };
}

/* ---------- planning ---------- */

/** NAVIGATOR call (cheap, every step): one validated PlanResult, with one retry
 * on invalid JSON carrying the validation error. Throws after the second invalid
 * response — the loop turns that into a brain escalation. */
async function navigateOnce(
  router: ModelRouter,
  { prompt, step }: { prompt: string; step: number },
): Promise<PlanResult> {
  const raw = await router.planJson(prompt, PLAN_JSON_SCHEMA, step);
  const parsed = PlanResultSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // one retry with the validation error attached
  const retryRaw = await router.planJson(
    `${prompt}\n\nYour previous response was invalid: ${parsed.error.message.slice(0, 300)}\nRespond again with ONLY valid JSON.`,
    PLAN_JSON_SCHEMA,
    step,
  );
  const retry = PlanResultSchema.safeParse(retryRaw);
  if (retry.success) return retry.data;
  throw new Error(`navigator returned invalid actions twice: ${retry.error.message.slice(0, 200)}`);
}

/** BRAIN call (smart, rare): one validated GoalPlan, with one retry on invalid
 * JSON carrying the validation error. Same retry-with-validation-error shape as
 * navigateOnce; throws after the second invalid response. */
async function planGoalsOnce(
  router: ModelRouter,
  { prompt, step }: { prompt: string; step: number },
): Promise<GoalPlan> {
  const raw = await router.planGoals(prompt, GOAL_PLAN_JSON_SCHEMA, step);
  const parsed = GoalPlanSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // one retry with the validation error attached
  const retryRaw = await router.planGoals(
    `${prompt}\n\nYour previous response was invalid: ${parsed.error.message.slice(0, 300)}\nRespond again with ONLY valid JSON.`,
    GOAL_PLAN_JSON_SCHEMA,
    step,
  );
  const retry = GoalPlanSchema.safeParse(retryRaw);
  if (retry.success) return retry.data;
  throw new Error(`brain returned an invalid goal plan twice: ${retry.error.message.slice(0, 200)}`);
}

/* ---------- execution ---------- */

async function executeWithRetry(browser: BrowserPort, action: Action, planTree: AxNode): Promise<void> {
  try {
    await executeOnce(browser, action);
  } catch (firstErr) {
    // DOM may have shifted between snapshot and execution: re-resolve the
    // target by role+name in a FRESH tree and retry once
    if (
      action.type !== 'click' &&
      action.type !== 'type' &&
      action.type !== 'hover' &&
      action.type !== 'select_option' &&
      action.type !== 'upload_file' &&
      action.type !== 'blur'
    ) {
      throw firstErr;
    }
    const target = findNode(planTree, action.nodeId);
    if (!target) throw firstErr;
    const fresh = await browser.axTree();
    const match = findByRoleName(fresh.root, target.role, target.name);
    if (!match) throw firstErr;
    await executeOnce(browser, { ...action, nodeId: match.id });
  }
}

async function executeOnce(browser: BrowserPort, action: Action): Promise<void> {
  switch (action.type) {
    case 'navigate':
      return browser.navigate(action.url);
    case 'click':
      return browser.click(action.nodeId);
    case 'type':
      return browser.type(action.nodeId, action.text);
    case 'hover':
      return browser.hover(action.nodeId);
    case 'press_key':
      return browser.pressKey(action.key);
    case 'select_option':
      return browser.selectOption(action.nodeId, action.value);
    case 'reload':
      return browser.reload();
    case 'go_back':
      return browser.goBack();
    case 'upload_file':
      return browser.uploadFile(action.nodeId, action.paths);
    case 'blur':
      return browser.blur(action.nodeId);
    case 'mouse':
      return browser.mouse(action.kind, action.x, action.y);
    case 'wait':
      return sleep(action.ms);
    default:
      throw new Error(`executeOnce: unexpected action ${action.type}`);
  }
}

async function executeCacheAction(
  browser: BrowserPort,
  action: Action,
  planTree: AxNode,
  runData: ReturnType<typeof createRunDataState>,
  vault: Vault | undefined,
): Promise<void> {
  if (action.type === 'type') {
    const resolvedRun = resolveRunPlaceholders(action.text, runData).text;
    const resolved = resolveSecrets(resolvedRun, vault);
    await executeWithRetry(browser, { ...action, text: resolved }, planTree);
    return;
  }
  if (action.type === 'assert_dom') {
    const t = findNode(planTree, action.nodeId);
    const hay = t ? subtreeText(t) : '';
    if (!t || !hay.toLowerCase().includes(action.contains.toLowerCase())) {
      throw new Error(`cached DOM assertion failed for ${action.nodeId}`);
    }
    return;
  }
  if (action.type === 'extract') {
    // model-assisted (prompt-driven) extraction is never cached — only the $0
    // DOM-text/regex path (which always has a nodeId) reaches this function.
    if (!action.nodeId) throw new Error(`cached extract for ${action.key} has no nodeId (model-assisted extraction is not cacheable)`);
    const t = findNode(planTree, action.nodeId);
    if (!t) throw new Error(`cached extract target ${action.nodeId} not in current tree`);
    const value = extractValue(subtreeText(t).trim(), action.pattern);
    if (!value) throw new Error(`cached extract ${action.key} produced no value`);
    recordExtraction(runData, { key: action.key, value, source: 'dom', label: t.name });
    return;
  }
  if (
    action.type === 'assert_visual' ||
    action.type === 'finish' ||
    action.type === 'drag_and_drop' ||
    action.type === 'open_tab' ||
    action.type === 'switch_tab' ||
    action.type === 'close_tab' ||
    action.type === 'script'
  ) {
    throw new Error(`cached ${action.type} is not executable through the action cache`);
  }
  await executeWithRetry(browser, action, planTree);
}

async function startAssertionClip(cdpClient: unknown, artifacts: ArtifactStore) {
  try {
    return await startClipRecorder(cdpClient as CdpClientLike, artifacts, { maxFps: 4, maxWidth: 800 });
  } catch {
    return null;
  }
}

/* ---------- tree helpers ---------- */

function findNode(root: AxNode, id: string): AxNode | undefined {
  if (root.id === id) return root;
  for (const c of root.children ?? []) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return undefined;
}

/** Count nodes sharing `role`+`name` in document (pre-order, recursive-children)
 * order — the SAME traversal replay's collectByRoleName / Playwright .nth() use —
 * and report the 0-based index of the node with `targetId` among them. Returns
 * `index = -1` if the target isn't found. Exported for unit testing (#6). */
export function rankByRoleName(
  root: AxNode,
  role: string,
  name: string | undefined,
  targetId: string,
): { count: number; index: number } {
  let count = 0;
  let index = -1;
  const walk = (n: AxNode): void => {
    if (n.role === role && n.name === name) {
      if (n.id === targetId) index = count;
      count++;
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return { count, index };
}

function findByRoleName(root: AxNode, role: string, name?: string): AxNode | undefined {
  if (root.role === role && root.name === name) return root;
  for (const c of root.children ?? []) {
    const hit = findByRoleName(c, role, name);
    if (hit) return hit;
  }
  return undefined;
}

function subtreeText(node: AxNode): string {
  const parts: string[] = [];
  const walk = (n: AxNode) => {
    if (n.name) parts.push(n.name);
    if (n.value) parts.push(n.value);
    for (const c of n.children ?? []) walk(c);
  };
  walk(node);
  return parts.join(' ');
}

function extractValue(text: string, pattern?: string): string | null {
  const trimmed = text.trim();
  if (!pattern) return trimmed || null;
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    return null;
  }
  const match = re.exec(trimmed);
  if (!match) return null;
  return (match[1] ?? match[0]).trim() || null;
}

function cachedTargetForRecord(value: CachedActionValue): { role: string; name?: string; nth?: number; qaId?: string } | undefined {
  if (!('target' in value)) return undefined;
  return {
    role: value.target.role,
    ...(value.target.name && { name: value.target.name }),
    ...(value.target.nth !== undefined && { nth: value.target.nth }),
    ...(value.target.qaId && { qaId: value.target.qaId }),
  };
}

/** A redacted target string for the audit log: the touched node's role+name,
 * or the navigate url, or undefined. NEVER includes resolved secret values
 * (a type action's text — which may carry the {{secret:…}} placeholder — is
 * deliberately not logged as the target). */
function auditTarget(action: Action, target?: { role: string; name?: string }): string | undefined {
  if (action.type === 'navigate') return action.url;
  if (target) return target.name ? `${target.role} "${target.name}"` : target.role;
  if (action.type === 'press_key') return action.key;
  if (action.type === 'reload') return 'reload';
  if (action.type === 'go_back') return 'go_back';
  if (action.type === 'extract') return action.key;
  return undefined;
}

function lastInteraction(steps: StepRecord[]): FailingStep | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (
      s.action.type === 'click' ||
      s.action.type === 'type' ||
      s.action.type === 'hover' ||
      s.action.type === 'press_key' ||
      s.action.type === 'select_option' ||
      s.action.type === 'navigate' ||
      s.action.type === 'reload' ||
      s.action.type === 'go_back'
    ) {
      return { index: s.index, action: s.action, description: s.description };
    }
  }
  return null;
}
