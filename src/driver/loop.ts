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

import fs from 'node:fs';
import type { AxNode, AxSnapshot, BrowserPort } from '../ports/browser-port.js';
import { isHostAllowed } from '../ports/browser-port.js';
import { firstError } from '../capture/console-network.js';
import { findOtp, type EmailMessage, type EmailProvider } from '../email/index.js';
import { loadAppModel, appModelPath, type AppModel } from '../discovery/index.js';
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
import { checkDrainInvariants, checkProbeInvariants, type InvariantViolation } from '../assertions/invariants.js';
import { evaluateAssertion, type AssertionSpec } from '../assertions/dom-assertions.js';
import { axToObservation, checkRelation, detectRelationCandidates } from '../assertions/metamorphic.js';
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

/** A12 (P1): race any CDP or model call against a hard deadline so a hung call
 * (dropped debugger connection, stalled LLM HTTP/CLI call) surfaces as a
 * rejected promise instead of blocking the run forever. Follows the same
 * reject-with-timer-and-message shape as CliPlannerAdapter's own child-process
 * timeout (src/router/adapters/cli-planner.ts) — the losing side is simply
 * abandoned, not cancelled. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
/** CDP calls (axTree/screenshot) — a dropped debugger connection should surface
 * quickly rather than hang the run. */
const CDP_CALL_TIMEOUT_MS = 15_000;
/** Navigator/brain calls — a stalled HTTP/CLI call should surface quickly rather
 * than hang the run; this is a loop-level backstop on top of any per-adapter
 * timeout (e.g. CliPlannerAdapter's own 120s child-process timeout, matched by
 * every other adapter's default `timeoutMs` — google-cli, anthropic, byok-gemini,
 * ollama, openai-compatible). Must stay ABOVE that 120s so it backstops a truly
 * hung call instead of preempting a legitimately slow-but-working one — a lower
 * value (previously 30s) fired before any adapter's own timeout ever could,
 * turning normal CLI cold-spawn latency into spurious "timed out" failures. */
const LLM_CALL_TIMEOUT_MS = 130_000;

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
/** A2 (P0): navigator-only mode (no plan-goals adapter configured) has nobody
 * to ask when stuck, so escalate() retries once per stuck event with a fresh
 * look at the page instead of ending the run immediately (see escalate()'s
 * `!brainAvailable` branch). This is the terminal cap for THAT retry loop —
 * deliberately a different, slightly higher number than MAX_BRAIN_ESCALATIONS
 * since there is no brain to burn cost on, only wall-clock/step budget. */
const MAX_NAVIGATOR_ONLY_RECOVERY_ATTEMPTS = 3;

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
        `secret "${name}" not found — add it with: spike secret set ${name}`,
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

/** A45 (P2): delegates to browser-port.ts's isHostAllowed so both layers of
 * the Tier-4 guard share one matching rule (exact/www-only, `.`-prefixed
 * entries opt into subdomain-suffix trust) instead of two hand-copies that
 * can silently drift apart. */
const hostAllowed = isHostAllowed;

/** wait_for_email defaults — see actions.ts's zod/JSON-schema docs. */
const WAIT_FOR_EMAIL_DEFAULT_TIMEOUT_MS = 30_000;
const WAIT_FOR_EMAIL_POLL_INTERVAL_MS = 500;

/** Discovery app-model → brain prompt (feed the crawl into buildGoalPlannerPrompt).
 * ~4 chars/token heuristic — matches no existing token counter in this file, so
 * this is intentionally approximate; the cap only needs to keep the prompt
 * bounded, not be exact. */
const SITE_MAP_MAX_CHARS = 1_200; // ~300 tokens
/** Ignore a `.spike/app-model.json` older than this — a stale crawl is worse
 * than none (see the section's own "may be stale" framing, which covers the
 * remaining risk of a crawl that's recent but the site changed since). */
const SITE_MAP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** One line per route: path, exercised/not, and a few key interactive
 * elements from its most recent structural state — enough for the brain to
 * recognize "there's a /checkout route with a Place order button" without
 * re-deriving it from scratch. Oldest routes are trimmed first (mirrors
 * planner-prompt.ts's formatHistory .slice(-N) overflow convention) until the
 * summary fits SITE_MAP_MAX_CHARS. */
function summarizeAppModel(model: AppModel): string {
  const lines = [...model.routes]
    .sort((a, b) => a.discoveredAt.localeCompare(b.discoveredAt))
    .map((r) => {
      const latestState = r.states[r.states.length - 1];
      const elementBits = (latestState?.elements ?? [])
        .slice(0, 5)
        .map((e) => (e.name ? `${e.role} "${e.name}"` : e.role));
      const label = r.exercised ? 'exercised' : 'not exercised';
      return `- ${r.route} [${label}]${elementBits.length ? `: ${elementBits.join(', ')}` : ''}`;
    });
  while (lines.length > 1 && lines.join('\n').length > SITE_MAP_MAX_CHARS) lines.shift();
  return lines.join('\n');
}

/** Never throws and never blocks planning: a missing/corrupt/stale/wrong-host
 * app-model just means "no site map to offer" (mirrors loadAppModel's own
 * never-throws contract). `targetUrl` is the run's target — see LoopOptions
 * doc comments; host coverage is checked against the model's single
 * `baseUrl` (one app-model file describes one site, not per-route hosts). */
function loadSiteMapSummary(targetUrl: string): string | undefined {
  try {
    const p = appModelPath();
    if (!fs.existsSync(p)) return undefined;
    if (Date.now() - fs.statSync(p).mtimeMs > SITE_MAP_MAX_AGE_MS) return undefined;
    const model = loadAppModel();
    if (!model || !model.baseUrl || !model.routes.length) return undefined;
    if (hostOf(model.baseUrl) !== hostOf(targetUrl)) return undefined;
    const summary = summarizeAppModel(model);
    return summary || undefined;
  } catch {
    return undefined;
  }
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
  | 'email'
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
  /** Email/OTP module wiring: the EmailProvider instance a `wait_for_email`
   * action polls (e.g. fixture/server.ts's fixtureEmailProvider for the
   * dogfood app, or a fresh FakeLocalEmailProvider in tests). Same
   * caller-injects-the-instance shape as `vault`. Omitted (the common case
   * today — QaConfig.emailProvider defaults to 'none') → `wait_for_email`
   * fails cleanly instead of hanging or silently no-op'ing. */
  emailProvider?: EmailProvider;
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
  /** A1 (P0): let the deterministic oracle layer GATE the final verdict
   * instead of merely informing it — see findStrictOracleViolation. Defaults
   * to true here (mirrors QaConfig.strictOracles's default) so a direct
   * caller that never threads the config value through still gets the safe
   * default rather than silently falling back to pre-A1 evidence-only
   * behavior. */
  strictOracles?: boolean;
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
    // A5's deterministic assertion verbs report as the same onStep kind as the
    // two that predate them — to a watching UI an assertion is an assertion.
    case 'assert_text':
    case 'assert_count':
    case 'assert_url':
    case 'assert_state':
    case 'assert_network':
    case 'assert_no_console_errors':
      return 'assert';
    case 'extract':
      return 'extract';
    case 'wait_for_email':
      return 'email';
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
    case 'assert_text':
      return `Check ${tgt ?? 'page'} text ${action.mode} "${action.value}"`;
    case 'assert_count':
      return `Check ${action.comparator} ${action.expected} ${action.role}${action.name ? ` "${action.name}"` : ''}`;
    case 'assert_url':
      return `Check URL ${action.mode} "${action.value}"`;
    case 'assert_state':
      return `Check ${tgt ?? action.target} is ${action.state}`;
    case 'assert_network':
      return `Check request "${action.urlPattern}" ${action.absent ? 'absent' : `→ ${action.status ?? action.statusClass ?? 'any'}`}`;
    case 'assert_no_console_errors':
      return 'Check no console errors';
    case 'extract':
      return action.prompt
        ? `Extract ${action.key} (model-assisted: ${action.prompt.slice(0, 60)})`
        : `Extract ${action.key} from ${tgt ?? action.nodeId ?? 'page'}`;
    case 'wait_for_email':
      return `Wait for email${action.matching ? ` matching "${action.matching}"` : ''}${action.extractOtpTo ? ` (extract OTP to ${action.extractOtpTo})` : ''}`;
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

/** A24 Tier-0 oracle: run the deterministic invariants over a step's freshly
 * drained evidence and stamp any violations onto the record.
 *
 * Called at all three drain sites (main batch, cached-action, finish pass) so
 * evidence is uniform regardless of how the step was produced. Deliberately
 * NON-FATAL for now: violations are recorded and fed to the planner as
 * evidence, but do not decide the verdict — the oracle has never been dogfooded
 * against a real passing run (A1), and auto-failing on it before then would
 * silently change outcomes on a codebase whose only recorded runs are failures.
 * Flipping error-severity violations into a hard fail is the follow-up, once a
 * green baseline exists to measure the false-positive rate against.
 *
 * Best-effort throughout: a port with no `probeInvariants` (extension
 * transport) still gets the drain-derived rules, and a probe that throws is
 * swallowed rather than failing the step. */
async function collectInvariants(browser: BrowserPort, record: StepRecord): Promise<void> {
  const url = await browser.url().catch(() => '');
  const violations = checkDrainInvariants({ console: record.console, network: record.network, url });
  if (browser.probeInvariants) {
    try {
      violations.push(...checkProbeInvariants(await browser.probeInvariants()));
    } catch {
      /* the probe is evidence, never a gate — a page that refuses evaluation
       * (CSP, mid-navigation, detached target) must not fail the run. */
    }
  }
  if (violations.length) record.invariants = violations;
}

/** A22 (P2): a step that FAILED gets a screenshot, immediately.
 *
 * Screenshots were previously taken at only three moments — the finish
 * confirmation, an explicit `assert_visual`, and a final fallback on the last
 * step. Correct for speed (a shot per step is expensive and most steps are
 * uninteresting), but it means a step that failed MID-flow leaves no visual
 * evidence at all: on a 200-flow suite the only way to see what a red run
 * looked like is to run it again and hope it reproduces. One shot on the
 * failure path costs nothing on the happy path.
 *
 * Best-effort by construction: capture failures are swallowed (the page may be
 * mid-navigation or gone), and an existing screenshot is never overwritten. */
async function captureFailureShot(
  browser: BrowserPort,
  artifacts: ArtifactStore,
  record: StepRecord,
): Promise<void> {
  if (record.ok || record.screenshot) return;
  try {
    const png = await withTimeout(browser.screenshot(), CDP_CALL_TIMEOUT_MS, 'screenshot');
    record.screenshot = await artifacts.saveScreenshot(record.index, png);
  } catch {
    /* evidence is a nice-to-have — never let it turn a step failure into a crash */
  }
}

/** A5: the deterministic assertion verbs — evaluated by the pure evaluator
 * rather than by a model, and read-only (never mutating, so the Tier-4 guard
 * and read-only mode leave them alone). `assert_dom` is deliberately NOT in
 * this set: its substring semantics are load-bearing for already-recorded
 * scripts and for the action cache, so it keeps its original inline path. */
const DETERMINISTIC_ASSERTIONS = new Set([
  'assert_text',
  'assert_count',
  'assert_url',
  'assert_state',
  'assert_network',
  'assert_no_console_errors',
]);

function isDeterministicAssertion(action: Action): action is Extract<Action, AssertionSpec> {
  return DETERMINISTIC_ASSERTIONS.has(action.type);
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
  const emailProvider = opts.emailProvider;
  const signal = opts.signal;
  // Discovery app-model → brain prompt: computed ONCE from the run's target
  // (never re-derived per navigator step — this only ever feeds the BRAIN's
  // goal-planning calls). Best-effort — see loadSiteMapSummary's doc comment.
  const siteMapSummary = loadSiteMapSummary(url);
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const perGoalMaxSteps = opts.perGoalMaxSteps ?? Math.min(maxSteps, DEFAULT_PER_GOAL_STEPS);
  const assertionPolicy = opts.assertionPolicy ?? 'single-ladder';
  const videoAssertions = opts.videoAssertions ?? false;
  // A5b (P1 safety): see LoopOptions.readOnly's doc comment for the default split.
  const readOnly = opts.readOnly ?? false;
  // A5a (P1 safety): undefined/0/negative all mean "no cap" (config.ts/service.ts
  // already normalize a set value to a positive finite number before it gets here).
  const spendCapUsd = opts.spendCapUsd && opts.spendCapUsd > 0 ? opts.spendCapUsd : undefined;
  // A1 (P0): default true — see LoopOptions.strictOracles's doc comment.
  const strictOracles = opts.strictOracles ?? true;
  const assertionTrace: AssertionTraceEntry[] = [];
  const runData = createRunDataState();
  const actionCache = opts.actionCache;
  const actionCacheStats = { enabled: Boolean(actionCache), hits: 0, misses: 0, stale: 0, stored: 0 };

  // A6 (P0): everything the run can throw from here on (dropped CDP
  // connections, a hung page mid-escalate(), etc.) is wrapped in the
  // try/catch right below runMain's declaration, so a crash still yields a
  // persisted, evidence-bearing report instead of a bare rejected promise.
  // runMain is a closure (not a separate function) specifically so it can
  // read/mutate every `let` declared in this outer scope (steps, verdict,
  // reason, failingStep, …) without threading them through a return value —
  // whatever got mutated before a throw is exactly "whatever accumulated".
  const runMain = async (): Promise<void> => {
  await browser.navigate(url);
  browser.drainConsole();
  browser.drainNetwork(); // initial page load noise is not step evidence

  let stepIndex = 0; // running index across batches, bounded by maxSteps
  let lastBatchFirstSig: string | null = null; // for loop detection
  // A27 (P1): rolling ax.text history for the repeat detector's pre/post-
  // action comparison — one entry pushed per outer iteration (right after
  // that iteration's fresh snapshot), capped at 3 (the oldest is "before the
  // 2-repeat window began", the newest is "now", i.e. after both already-
  // executed repeats landed). A same-action 3× streak only counts as a real
  // stall when the tree is IDENTICAL across that whole window — see the
  // repeat-detection block below.
  let recentTreeTexts: string[] = [];
  let lastSnapshotAx: AxSnapshot | null = null; // last tree text, for the uncertain-reason heuristic
  // A1 (P0): the FIRST tree snapshot of the run — paired with the last one as
  // a best-effort before/after Observation for the Tier-2 metamorphic gate.
  let firstSnapshotAx: AxSnapshot | null = null;
  /** A32: role+name of the most recent successfully-acted-on target — the
   * anchor for a focused re-serialization when the tree overflows its budget. */
  let lastTouchedTarget: { role: string; name?: string } | undefined;
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
  // A2 (P0): navigator-only mode's analogue of brainEscalations — how many
  // consecutive "stuck" events escalate() has retried (fresh snapshot, no
  // brain to ask) without navigator progress. Reset on the same progress
  // signals as brainEscalations (goal completion, a real action landing).
  let noBrainRecoveryAttempts = 0;
  // Whether a BRAIN (plan-goals) adapter is configured at all. Set from the router
  // just before the initial plan. When false the run degrades to navigator-only:
  // one implicit goal = the task, and escalate() ends honestly (no brain to ask).
  let brainAvailable = true;

  /* Escalate to the BRAIN with a failure reason and apply its answer:
   *  - a final verdict → end the run with it;
   *  - replacement goals (completed ones kept) → keep navigating the new plan;
   *  - a hint → feed it to the next navigator call;
   *  - nothing useful, or the escalation cap is hit → end honestly (uncertain).
   * Returns 'continue' to keep the outer loop going, 'end' to stop it.
   *
   * `kind` (A2, P0) distinguishes ONLY how the no-brain branch below reacts:
   * 'per-goal-overflow' is not a stuck signal in navigator-only mode — global
   * maxSteps is the only cap there — everything else ('stuck', the default:
   * blocked / 3×-repeat / invalid navigator JSON / no actions returned) gets
   * one retry with a fresh look at the page before the local recovery cap
   * ends the run honestly. Brain-available behavior is UNCHANGED by `kind`. */
  const escalate = async (failure: string, kind: 'per-goal-overflow' | 'stuck' = 'stuck'): Promise<'continue' | 'end'> => {
    if (signal?.aborted) {
      reason = 'cancelled by user';
      return 'end';
    }
    // navigator-only mode (no brain configured): there is nobody to ask, but
    // that no longer means "give up immediately" (A2 — see the doc comment
    // above and docs/plan/26-08-27-audit-market-readiness.md A2).
    if (!brainAvailable) {
      if (kind === 'per-goal-overflow') {
        // global maxSteps is the only cap in navigator-only mode; the caller
        // already resets stepsInGoal on any 'continue' outcome.
        return 'continue';
      }
      if (noBrainRecoveryAttempts >= MAX_NAVIGATOR_ONLY_RECOVERY_ATTEMPTS) {
        const visibleErr = visibleErrorText(lastSnapshotAx?.text);
        verdict = 'uncertain';
        reason =
          `stuck: ${failure}` +
          (visibleErr ? ` — page shows: "${visibleErr}" (likely the real cause)` : '') +
          ' — could not recover without a planner';
        return 'end';
      }
      noBrainRecoveryAttempts++;
      // retry once with a fresh look — the next outer-loop iteration always
      // re-fetches browser.axTree() before planning, so no extra CDP call is
      // needed here; just reset loop-detection so the retry isn't immediately
      // re-tripped by stale history.
      lastBatchFirstSig = null;
      onStep({
        index: stepIndex,
        kind: 'plan',
        text: `Stuck (${failure.slice(0, 80)}) — retrying with a fresh look at the page (no planner configured, attempt ${noBrainRecoveryAttempts}/${MAX_NAVIGATOR_ONLY_RECOVERY_ATTEMPTS}).`,
      });
      return 'continue';
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
    // A32: only ask for a focused serialization when the PREVIOUS snapshot
    // actually hit the char budget. A19 built the capability; using it
    // unconditionally would narrow the navigator's view on pages that fit
    // fine, which is a regression, not an optimisation. When the tree did
    // truncate, anchor on the region around the last thing we touched — that
    // is where the next action almost certainly is, and it is the part blind
    // truncation was most likely to have thrown away.
    const focusHint =
      lastSnapshotAx?.truncated && lastTouchedTarget
        ? { focus: { role: lastTouchedTarget.role, ...(lastTouchedTarget.name && { name: lastTouchedTarget.name }) } }
        : undefined;
    const ax = await withTimeout(browser.axTree(focusHint), CDP_CALL_TIMEOUT_MS, 'axTree');
    if (focusHint) {
      onStep({ index: stepIndex, kind: 'plan', text: `page too large to serialize whole — focusing on ${focusHint.focus.role}${focusHint.focus.name ? ` "${focusHint.focus.name}"` : ''}` });
    }
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
          siteMapSummary,
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
    const png = await withTimeout(browser.screenshot(), CDP_CALL_TIMEOUT_MS, 'screenshot');
    record.screenshot = await artifacts.saveScreenshot(i, png);
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
    await collectInvariants(browser, record);
    await artifacts.appendAudit({
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
    const ax = await withTimeout(browser.axTree(), CDP_CALL_TIMEOUT_MS, 'axTree');
    lastSnapshotAx = ax;
    firstSnapshotAx ??= ax;
    const planUrl = await browser.url();
    onStep({ index: stepIndex, kind: 'plan', text: 'Planning goals…' });
    try {
      const goalPlan = await planGoalsOnce(router, {
        prompt: buildGoalPlannerPrompt({ task, url: planUrl, axText: ax.text, siteMapSummary }),
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

  // A26 (P1): a FIXED budget for the WHOLE run, computed ONCE from the
  // initial goal count — deliberately NOT recomputed after a brain re-plan
  // swaps in a fresh goals[] (escalate()'s `goals = [...goals.slice(0,
  // currentGoal), ...gp.goals]`). Recomputing from the live goals.length
  // would let an adversarial/misbehaving re-plan keep the bound growing in
  // lockstep with goalTransitions (each escalation resets brainEscalations
  // on the very next goalComplete — see that branch below — so an
  // escalate-then-complete cycle can repeat indefinitely without ever
  // tripping MAX_BRAIN_ESCALATIONS). MAX_BRAIN_ESCALATIONS * 12 gives room
  // for that many escalation-driven re-plans (each capped at 12 new goals —
  // see GoalPlanSchema) before the run is forced to end honestly regardless
  // of how large goals has grown by then.
  const maxGoalTransitions = goals.length + MAX_BRAIN_ESCALATIONS * 12;
  let goalTransitions = 0;

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

    const ax = await withTimeout(browser.axTree(), CDP_CALL_TIMEOUT_MS, 'axTree');
    lastSnapshotAx = ax;
    firstSnapshotAx ??= ax;
    // A27: one sample per outer iteration, capped at 3 — see recentTreeTexts's
    // doc comment above.
    recentTreeTexts.push(ax.text);
    if (recentTreeTexts.length > 3) recentTreeTexts.shift();
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
        // A20 (P1): verify BEFORE execute — a mutating cache hit must never
        // dispatch first and check correctness after (a wrong hit is a real
        // side effect on the app under test: submit/delete/add-to-cart…).
        // Resolution against the CURRENT tree already happened above
        // (actionFromCachedValue); unambiguous resolution is enforced inside
        // it (A21 — findByCachedTarget/pickClearCacheWinner returns null on a
        // same-role+name collision with no `nth`, which actionFromCachedValue
        // already surfaces as `cachedAction === null` above). What's left is
        // actionability (A19's waitForActionable) — on failure, treat this
        // exactly like any other stale/unresolvable hit: a cache MISS that
        // falls through to the navigator this step, never a guess.
        if (cachedAction.type === 'click' || cachedAction.type === 'type' || cachedAction.type === 'select_option') {
          try {
            await browser.waitForActionable?.(cachedAction.nodeId);
          } catch {
            actionCacheStats.stale++;
            continue;
          }
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
        await collectInvariants(browser, record);
        await artifacts.appendAudit({
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
      // A26 (P1): count this transition against the FIXED whole-run budget —
      // see maxGoalTransitions's doc comment above the outer while loop.
      // goalComplete never touches stepIndex, so without this a run that
      // keeps completing goals (an oversized/repeatedly-re-planned checklist)
      // never trips maxSteps either.
      goalTransitions++;
      if (goalTransitions > maxGoalTransitions) {
        verdict = 'uncertain';
        reason = `goal transitions (${goalTransitions}) exceeded the bound (${maxGoalTransitions}) — the navigator kept completing goals without the run settling`;
        break;
      }
      currentGoal++;
      hint = undefined;
      stepsInGoal = 0;
      brainEscalations = 0; // completing a goal is progress
      noBrainRecoveryAttempts = 0;
      // A27 (P1): a goal boundary invalidates the repeat detector's history —
      // a fresh goal starting with the "same" action type as the tail of the
      // last one is not a loop.
      lastBatchFirstSig = null;
      recentTreeTexts = [];
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
    // A27 (P1): effect-blind check — a same-action 3× streak only counts as a
    // real stall when the page tree is IDENTICAL across the whole repeated
    // window (recentTreeTexts[0] = 2 iterations back, i.e. before the first
    // already-executed repeat; recentTreeTexts[2] = now, i.e. after the
    // second one landed). An action that changed the page — a stepper "+"
    // button, a wizard "Next" — is progress, not a loop, even when the
    // action TYPE repeats. Too little history (early in the run) can't prove
    // a stall either way, so it defaults to "not a loop" (the safe
    // direction — see recentTreeTexts.length === 3 below).
    const repeatedActionHadNoEffect = recentTreeTexts.length === 3 && recentTreeTexts[0] === recentTreeTexts[2];
    if (
      firstSig !== null &&
      firstSig === lastBatchFirstSig &&
      steps.length >= 2 &&
      JSON.stringify(steps[steps.length - 1].action) === firstSig &&
      JSON.stringify(steps[steps.length - 2].action) === firstSig &&
      repeatedActionHadNoEffect
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
        ...(batchUrl && { url: batchUrl }),
      };
      // remember WHAT the action touches (role+name) — this is what makes the
      // run replayable later; nodeIds die with the snapshot. `extract`'s nodeId
      // is optional (Phase 15 model-assisted mode may target the whole page) —
      // the typeof guard both narrows action.nodeId to `string` and correctly
      // skips a nodeId-less extract.
      if ('nodeId' in action && typeof action.nodeId === 'string') {
        // A23: findNode + rankByRoleName combined into ONE tree walk (findNodeRanked)
        // instead of two independent traversals of the same ax.root.
        const found = findNodeRanked(ax.root, action.nodeId);
        const t = found?.node;
        if (t) {
          record.target = { role: t.role, ...(t.name && { name: t.name }) };
          // #6: when the snapshot held >1 node sharing this role+name, record
          // which one (0-based, document order) so replay/codegen can disambiguate.
          const { count, index } = found!;
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
        // A23: findNode + rankByRoleName combined into ONE tree walk per target.
        const srcFound = findNodeRanked(ax.root, action.sourceId);
        const dstFound = findNodeRanked(ax.root, action.targetId);
        const src = srcFound?.node;
        const dst = dstFound?.node;
        if (src) {
          record.target = { role: src.role, ...(src.name && { name: src.name }) };
          if (srcFound!.count > 1 && srcFound!.index >= 0) record.target.nth = srcFound!.index;
        }
        const sourceTarget = src
          ? { role: src.role, ...(src.name && { name: src.name }), ...(record.target?.nth !== undefined && { nth: record.target.nth }) }
          : undefined;
        let targetTarget: { role: string; name?: string; nth?: number } | undefined;
        if (dst) {
          targetTarget = {
            role: dst.role,
            ...(dst.name && { name: dst.name }),
            ...(dstFound!.count > 1 && dstFound!.index >= 0 && { nth: dstFound!.index }),
          };
        }
        if (sourceTarget || targetTarget) {
          record.action = { ...action, ...(sourceTarget && { sourceTarget }), ...(targetTarget && { targetTarget }) };
        }
      }
      steps.push(record);

      // ---- execute ----
      const cacheBefore =
        actionCache &&
        a === actions.length - 1 &&
        action.type !== 'finish' &&
        action.type !== 'assert_visual' &&
        action.type !== 'wait' &&
        // wait_for_email's "effect" is external mailbox state, not something a
        // replayed cache hit can reproduce — never cache it (mirrors wait/
        // assert_visual/finish above; see actionIntentForKey/toCachedActionValue
        // in cache/action-cache.ts, which reject it outright).
        action.type !== 'wait_for_email'
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
      // A3 (P0): set true when executeWithRetry recovers via a FRESH
      // browser.axTree() re-snapshot — that rebuilds the port's internal
      // nodeId->backendDOMNodeId map, so any LATER action in this same batch
      // would resolve its (now-stale) nodeId against the WRONG node if the
      // batch kept going. Checked below to discard the rest of the batch.
      let batchDirty = false;
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
          const png = await withTimeout(browser.screenshot(), CDP_CALL_TIMEOUT_MS, 'screenshot');
          record.screenshot = await artifacts.saveScreenshot(i, png);
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
        } else if (isDeterministicAssertion(action)) {
          // A5: the precise assertion verbs. Unlike assert_dom's substring
          // check above (kept byte-identical — recorded scripts and the action
          // cache reference it), these are evaluated by the pure evaluator in
          // assertions/dom-assertions.ts against the snapshot + url + this
          // step's drains. No model call, no I/O: the whole point is that an
          // expectation can be stated exactly rather than judged.
          const result = evaluateAssertion(action, {
            ax,
            url: batchUrl,
            network: record.network,
            console: record.console,
          });
          if (!result.ok) {
            record.ok = false;
            record.error = result.detail;
          }
        } else if (action.type === 'type') {
          // resolve {{secret:NAME}} AT EXECUTE TIME ONLY — the record keeps the
          // PLACEHOLDER (action is unchanged), so history/report/recorder/audit
          // never hold the real value. Missing secret → step fails.
          const resolvedRun = resolveRunPlaceholders(action.text, runData).text;
          const resolved = resolveSecrets(resolvedRun, vault);
          const typeOutcome = await executeWithRetry(browser, { ...action, text: resolved }, ax.root);
          batchDirty = typeOutcome.batchDirty;
          if (!typeOutcome.waited) record.description += ' [dispatched without confirming actionability — wait timed out]';
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
                const raw = await withTimeout(
                  router.planJson(
                    buildExtractPrompt({ prompt: action.prompt, key: action.key, text }),
                    EXTRACT_JSON_SCHEMA,
                    i,
                  ),
                  LLM_CALL_TIMEOUT_MS,
                  'extract planJson',
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
        } else if (action.type === 'wait_for_email') {
          // Email/OTP module wiring: poll the injected EmailProvider (never
          // constructed here — see LoopOptions.emailProvider's doc comment)
          // until a message matching `matching` arrives or `timeoutMs`
          // elapses. `extractOtpTo` set → findOtp() + the SAME recordExtraction()
          // mechanism `extract` uses above (source: 'email').
          if (!emailProvider) {
            record.ok = false;
            record.error = "no email provider configured — set emailProvider: 'fake-local' (or a future real provider)";
          } else {
            const timeoutMs = action.timeoutMs ?? WAIT_FOR_EMAIL_DEFAULT_TIMEOUT_MS;
            const matching = action.matching?.toLowerCase();
            const deadline = Date.now() + timeoutMs;
            let found: EmailMessage | null = null;
            for (;;) {
              if (signal?.aborted) break;
              const messages = await emailProvider.listMessages();
              found = matching
                ? messages.find((m) => `${m.subject}\n${m.text}\n${m.html ?? ''}`.toLowerCase().includes(matching)) ?? null
                : (messages[messages.length - 1] ?? null);
              if (found || Date.now() >= deadline) break;
              await sleep(WAIT_FOR_EMAIL_POLL_INTERVAL_MS);
            }
            if (!found) {
              record.ok = false;
              record.error = action.matching
                ? `no email matching ${JSON.stringify(action.matching)} arrived within ${timeoutMs}ms`
                : `no email arrived within ${timeoutMs}ms`;
            } else if (action.extractOtpTo) {
              const otp = findOtp(found);
              if (!otp) {
                record.ok = false;
                record.error = `no OTP pattern found in the matched email for ${action.extractOtpTo}`;
              } else {
                recordExtraction(runData, { key: action.extractOtpTo, value: otp, source: 'email', label: found.subject });
              }
            }
          }
        } else if (action.type === 'drag_and_drop') {
          // A28 (P1): route through the SAME stale-node retry every other
          // nodeId-based verb gets — this used to call browser.dragAndDrop()
          // directly, bypassing executeWithRetry's re-resolve-by-role+name
          // recovery entirely (a source/target detached between snapshot and
          // execution just threw, no retry). executeWithRetry also applies
          // the A19 actionability wait to BOTH sourceId and targetId before
          // dispatch.
          const dragOutcome = await executeWithRetry(browser, action, ax.root);
          batchDirty = dragOutcome.batchDirty;
          if (!dragOutcome.waited) record.description += ' [dispatched without confirming actionability — wait timed out]';
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
          const outcome = await executeWithRetry(browser, action, ax.root);
          batchDirty = outcome.batchDirty;
          if (!outcome.waited) record.description += ' [dispatched without confirming actionability — wait timed out]';
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

      // A13 (P1, best-effort — skipped): an event-driven "network idle" wait would
      // replace this fixed sleep, but BrowserPort exposes no non-destructive way to
      // check in-flight requests (drainConsole/drainNetwork consume the buffer this
      // step's record still needs) — adding one means extending BrowserPort/CdpBrowser,
      // out of scope here. Keeping the fixed wait until that primitive exists.
      await sleep(150); // let async fallout (fetches, navigations) land
      record.console = browser.drainConsole();
      record.network = browser.drainNetwork();
      await collectInvariants(browser, record);
      await captureFailureShot(browser, artifacts, record);
      if (record.ok && record.target) lastTouchedTarget = { role: record.target.role, ...(record.target.name && { name: record.target.name }) };

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
      await artifacts.appendAudit({
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
        noBrainRecoveryAttempts = 0;
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
        // A3 (P0): a mid-batch retry re-snapshot rebuilt the port's nodeMap —
        // any remaining action in this batch would resolve its nodeId against
        // the WRONG node (ids are sequential and per-snapshot). Discard the
        // rest of the batch; it re-plans against the fresh tree next step.
        if (batchDirty) break;
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
        'add it via SPIKE_ALLOWED_HOSTS or spike.config.json to allow interaction';
      break;
    }

    // ---- per-goal budget: a goal grinding on without completing → ask the brain ----
    if (!done && !finishReplan && stepsInGoal >= perGoalMaxSteps) {
      const outcome = await escalate(`goal "${goals[currentGoal]}" ran ${stepsInGoal} steps without completing`, 'per-goal-overflow');
      if (outcome === 'end') break;
      stepsInGoal = 0; // fresh budget for the (possibly re-planned) goal
    }
  }

  // ---- A1 (P0): Tier-2 metamorphic relations — best-effort, single-run
  // before/after (see assertions/metamorphic.ts's axToObservation doc: only
  // cart-count is generically extractable without app-specific knowledge;
  // relations needing items/state degrade to "no evidence either way", never
  // a false trigger, since both sides are then empty/undefined and every
  // relation's set/state-equality check treats that as equal). Folded onto
  // the LAST step's `invariants` (same InvariantViolation shape Tier-0 already
  // uses) so it flows through the existing evidence/report path with no new
  // Report field, and so findStrictOracleViolation below picks it up for
  // free via the SAME error-severity scan Tier-0 invariants already get. ----
  if (firstSnapshotAx && lastSnapshotAx && steps.length) {
    const candidates = detectRelationCandidates(lastSnapshotAx);
    if (candidates.length) {
      const before = axToObservation(firstSnapshotAx);
      const after = axToObservation(lastSnapshotAx, url);
      const relationEvidence: InvariantViolation[] = [];
      for (const c of candidates) {
        const violation = checkRelation(c.relation, before, after, c.params);
        if (!violation) continue;
        // only a RELIABLE-confidence relation with sufficient data can gate
        // strictOracles (error); a speculative relation, or a reliable one
        // that simply had no data to observe, is evidence only (warn) — see
        // metamorphic.ts's confidence doc comment: "worth a look", not
        // "definitely a regression".
        const gates = c.relation.confidence === 'reliable' && !violation.insufficientData;
        relationEvidence.push({
          rule: `metamorphic:${violation.relation}`,
          severity: gates ? 'error' : 'warn',
          detail: violation.detail,
          ...(violation.evidence && { evidence: JSON.stringify(violation.evidence).slice(0, 200) }),
        });
      }
      if (relationEvidence.length) {
        const last = steps[steps.length - 1];
        last.invariants = [...(last.invariants ?? []), ...relationEvidence];
      }
    }
  }

  // ---- A1 (P0): strictOracles — deterministic oracles GATE the verdict
  // instead of merely informing it. Off (strictOracles:false) restores the
  // pre-A1 evidence-only behavior: the model's own verdict stands untouched. ----
  if (strictOracles) {
    const oracle = findStrictOracleViolation(steps);
    if (oracle) {
      if (verdict !== 'fail') {
        verdict = 'fail';
        reason = oracle.reason;
        failingStep = { index: oracle.index, action: oracle.action, description: oracle.description };
      } else if (!failingStep) {
        failingStep = { index: oracle.index, action: oracle.action, description: oracle.description };
      }
    }
  }
  };

  try {
    await runMain();
  } catch (e) {
    // A6 (P0): genuine cancellation propagates as a rejection — everything
    // else (a dropped CDP connection, an unguarded browser.url()/axTree()
    // call inside escalate() while recovering from a broken page, …) still
    // yields a persisted, evidence-bearing 'uncertain' report instead of a
    // bare rejected promise. Whatever accumulated in `steps` before the
    // throw is exactly the evidence this report carries.
    if (signal?.aborted || (e instanceof Error && e.name === 'AbortError')) throw e;
    verdict = 'uncertain';
    reason = `run crashed: ${e instanceof Error ? e.message : String(e)}`;
  }
  // TS's control-flow narrowing can't see through the `runMain()` closure
  // call above (it may have reassigned `verdict` to 'pass'/'fail' inside),
  // so it otherwise narrows `verdict`'s type here to just 'uncertain' (its
  // last DIRECTLY-visible assignment) and flags the `=== 'fail'` check below
  // as an impossible comparison. Widen it back to the full declared union.
  verdict = verdict as RunVerdict;

  // ---- final evidence ----
  const lastStep = steps[steps.length - 1];
  if (lastStep && !lastStep.screenshot) {
    try {
      const png = await withTimeout(browser.screenshot(), CDP_CALL_TIMEOUT_MS, 'screenshot');
      lastStep.screenshot = await artifacts.saveScreenshot(lastStep.index, png);
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
  const reportPath = await artifacts.saveReport(report);
  report.evidence_paths.unshift(reportPath);
  // A5a: attach the compact spend summary BEFORE counting tokens — it is part of
  // the slim payload the caller reads back, so verdictPayloadTokens must include
  // it (see report.ts's SpendSummary doc comment).
  report.spendSummary = computeSpendSummary(report, spendCapUsd);
  const tokens = computeTokens(report);
  report.tokens = tokens;
  // tokenEstimate keeps its product-doc meaning: what the calling agent pays.
  report.tokenEstimate = tokens.verdictPayloadTokens;
  await artifacts.saveReport(report); // rewrite with final paths + estimate
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
  const raw = await withTimeout(router.planJson(prompt, PLAN_JSON_SCHEMA, step), LLM_CALL_TIMEOUT_MS, 'navigator planJson');
  const parsed = PlanResultSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // one retry with the validation error attached
  const retryRaw = await withTimeout(
    router.planJson(
      `${prompt}\n\nYour previous response was invalid: ${parsed.error.message.slice(0, 300)}\nRespond again with ONLY valid JSON.`,
      PLAN_JSON_SCHEMA,
      step,
    ),
    LLM_CALL_TIMEOUT_MS,
    'navigator planJson',
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
  const raw = await withTimeout(router.planGoals(prompt, GOAL_PLAN_JSON_SCHEMA, step), LLM_CALL_TIMEOUT_MS, 'brain planGoals');
  const parsed = GoalPlanSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // one retry with the validation error attached
  const retryRaw = await withTimeout(
    router.planGoals(
      `${prompt}\n\nYour previous response was invalid: ${parsed.error.message.slice(0, 300)}\nRespond again with ONLY valid JSON.`,
      GOAL_PLAN_JSON_SCHEMA,
      step,
    ),
    LLM_CALL_TIMEOUT_MS,
    'brain planGoals',
  );
  const retry = GoalPlanSchema.safeParse(retryRaw);
  if (retry.success) return retry.data;
  throw new Error(`brain returned an invalid goal plan twice: ${retry.error.message.slice(0, 200)}`);
}

/* ---------- execution ---------- */

/** A19 (P1): result of executeWithRetry. `batchDirty` is A3's unchanged
 * meaning (see below); `waited` is false when the pre-dispatch actionability
 * wait (waitForActionable) was attempted but timed out — the action is still
 * dispatched (today's pre-A19 behavior), the caller just records that the
 * wait didn't confirm actionability first. */
export interface ExecuteOutcome {
  batchDirty: boolean;
  waited: boolean;
}

/** A19 (P1): the node id(s) an action's actionability should be confirmed on
 * before dispatch, mirroring recorder/replay.ts's `waitForActionable?.()`
 * calls ahead of the SAME verbs (click/type/hover/select_option/upload_file/
 * blur/drag_and_drop's two targets) — now shared by BOTH the live
 * navigator-driven path and the action-cache execution path, since both
 * funnel mutating single-node actions through executeWithRetry. Actions with
 * no resolvable node target (navigate/reload/go_back/press_key/mouse/wait)
 * are not covered — there is nothing to probe. */
function actionabilityNodeIds(action: Action): string[] {
  switch (action.type) {
    case 'click':
    case 'type':
    case 'hover':
    case 'select_option':
    case 'upload_file':
    case 'blur':
      return [action.nodeId];
    case 'drag_and_drop':
      return [action.sourceId, action.targetId];
    default:
      return [];
  }
}

/** Execute one action, retrying ONCE via a fresh re-snapshot if the DOM
 * shifted between the batch's snapshot and execution. `batchDirty` is true
 * when the retry path fired (a fresh `browser.axTree()` was taken) — A3
 * (P0): that fresh snapshot rebuilds the port's internal
 * nodeId->backendDOMNodeId map (see cdp-browser.ts / playwright-browser.ts),
 * so any LATER action in the same batch would resolve its (now-stale)
 * nodeId against the WRONG node if the caller kept going — ids are
 * sequential per-snapshot, so a coincidental match silently hits a different
 * element with `ok: true`. The caller (loop.ts's main batch executor) treats
 * a `true` batchDirty as "batch dirty" and discards the rest of the batch
 * instead of risking a false-success wrong-element interaction.
 *
 * A19 (P1): before dispatch, waits for actionability (attached/visible/
 * enabled/stable — see BrowserPort.waitForActionable) on every node the
 * action touches. Best-effort: guarded by the optional method (a port/test
 * stub without it is a silent no-op, `waited` stays true) and a timeout
 * proceeds with the action anyway rather than failing the step outright —
 * see ExecuteOutcome's doc comment. */
async function executeWithRetry(browser: BrowserPort, action: Action, planTree: AxNode): Promise<ExecuteOutcome> {
  let waited = true;
  for (const nodeId of actionabilityNodeIds(action)) {
    try {
      await browser.waitForActionable?.(nodeId);
    } catch {
      waited = false; // timed out — proceed anyway (today's behavior); caller records this
    }
  }
  try {
    await executeOnce(browser, action);
    return { batchDirty: false, waited };
  } catch (firstErr) {
    // DOM may have shifted between snapshot and execution: re-resolve the
    // target(s) by role+name in a FRESH tree and retry once
    if (
      action.type !== 'click' &&
      action.type !== 'type' &&
      action.type !== 'hover' &&
      action.type !== 'select_option' &&
      action.type !== 'upload_file' &&
      action.type !== 'blur' &&
      // A28 (P1): drag_and_drop now gets the same stale-node retry every
      // other nodeId-based verb gets, instead of throwing straight through
      // on a single detached source/target.
      action.type !== 'drag_and_drop'
    ) {
      throw firstErr;
    }
    const fresh = await withTimeout(browser.axTree(), CDP_CALL_TIMEOUT_MS, 'axTree');
    if (action.type === 'drag_and_drop') {
      const srcNode = findNode(planTree, action.sourceId);
      const dstNode = findNode(planTree, action.targetId);
      if (!srcNode || !dstNode) throw firstErr;
      const srcMatch = findByRoleName(fresh.root, srcNode.role, srcNode.name);
      const dstMatch = findByRoleName(fresh.root, dstNode.role, dstNode.name);
      if (!srcMatch || !dstMatch) throw firstErr;
      await executeOnce(browser, { ...action, sourceId: srcMatch.id, targetId: dstMatch.id });
      return { batchDirty: true, waited };
    }
    const target = findNode(planTree, action.nodeId);
    if (!target) throw firstErr;
    const match = findByRoleName(fresh.root, target.role, target.name);
    if (!match) throw firstErr;
    await executeOnce(browser, { ...action, nodeId: match.id });
    return { batchDirty: true, waited };
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
    // A28 (P1): drag_and_drop is now dispatched through executeWithRetry
    // (previously called browser.dragAndDrop() directly from the main
    // executor, bypassing this function and the stale-node retry entirely).
    case 'drag_and_drop':
      return browser.dragAndDrop(action.sourceId, action.targetId);
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
    action.type === 'script' ||
    action.type === 'wait_for_email'
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

/** A23 (P2): find a node by id AND its same-role+name rank (see rankByRoleName)
 * from ONE recursive descent of `root` (flattened once), instead of the two
 * independent tree walks findNode + rankByRoleName would otherwise cost for
 * the same action target. Same document-order counting semantics as
 * rankByRoleName — no behavior change, just one walk instead of two. */
function findNodeRanked(root: AxNode, id: string): { node: AxNode; count: number; index: number } | undefined {
  const flat: AxNode[] = [];
  let target: AxNode | undefined;
  const walk = (n: AxNode): void => {
    flat.push(n);
    if (n.id === id) target = n;
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  if (!target) return undefined;
  let count = 0;
  let index = -1;
  for (const n of flat) {
    if (n.role === target.role && n.name === target.name) {
      if (n.id === id) index = count;
      count++;
    }
  }
  return { node: target, count, index };
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

/** A1 (P0): scan a finished run's steps for a deterministic oracle violation
 * that should GATE the verdict under strictOracles (see LoopOptions.strictOracles).
 * Priority, most to least reliable signal:
 *  (a) any step carrying an error-severity `invariants` entry — Tier-0
 *      page-health facts (rendered undefined/NaN, broken image, same-origin
 *      5xx…) plus any Tier-2 metamorphic relation folded in as 'error' by the
 *      caller. First occurrence wins; there is no "retry clears it" concept
 *      here, these are per-step facts, not assertions.
 *  (b) a failed deterministic assertion verb (assert_text/count/url/state/
 *      network — assert_dom is deliberately excluded, see
 *      DETERMINISTIC_ASSERTIONS's doc comment), deduped by exact action
 *      signature so a LATER successful retry of the identical assertion
 *      clears an earlier failure of it.
 * Returns null when nothing qualifies. */
function findStrictOracleViolation(
  steps: StepRecord[],
): { index: number; action: Action; description: string; reason: string } | null {
  for (const s of steps) {
    const err = s.invariants?.find((v) => v.severity === 'error');
    if (err) {
      return {
        index: s.index,
        action: s.action,
        description: s.description,
        reason: `deterministic oracle: ${err.detail}${err.evidence ? ` (${err.evidence})` : ''}`,
      };
    }
  }
  // last-outcome-per-signature: a later successful retry of the SAME
  // assertion (identical action object) clears an earlier failure of it.
  const lastBySignature = new Map<string, StepRecord>();
  for (const s of steps) {
    if (!isDeterministicAssertion(s.action)) continue;
    lastBySignature.set(JSON.stringify(s.action), s);
  }
  for (const s of lastBySignature.values()) {
    if (s.ok === false) {
      return {
        index: s.index,
        action: s.action,
        description: s.description,
        reason: `deterministic oracle: ${s.description} failed${s.error ? ` — ${s.error}` : ''}`,
      };
    }
  }
  return null;
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
