/* report.json — the product's contract. The first four fields are exactly what
 * the calling LLM reads (~2K tokens, product doc §6); everything after is for
 * humans and debugging. */

import type { ConsoleEntry, NetworkEntry } from '../ports/browser-port.js';
import type { InvariantViolation } from '../assertions/invariants.js';
import type { NanoVerdict } from '../ports/nano-port.js';
import type { Action } from '../driver/actions.js';
import type { ModelTraceEntry } from '../router/model-router.js';
import type { AssertionTraceEntry } from '../assertions/policy.js';
import type { RunDataState } from '../run-data/index.js';

export type RunVerdict = 'pass' | 'fail' | 'uncertain';

export interface StepTarget {
  role: string;
  name?: string;
  /** 0-based index of this node among all snapshot nodes sharing its role+name,
   * in document (recursive-children) order. Set by the driver loop ONLY when the
   * snapshot held >1 such node — disambiguates duplicate locators on replay
   * (#6). Absent → there was exactly one match. */
  nth?: number;
  /** Stable `data-qa-id` attribute stamped on a name-less interaction target so
   * replay has a fallback locator when role+name is unusable (#9). Best-effort:
   * stamped attributes don't survive a page reload, so replay treats it as a
   * last resort behind role+name. */
  qaId?: string;
}

export interface StepRecord {
  index: number;
  thought?: string;
  action: Action;
  description: string;
  /** Role+name of the node the action touched — what makes a run replayable
   * (nodeIds are per-snapshot and meaningless across runs). */
  target?: StepTarget;
  ok: boolean;
  error?: string;
  /** A29: the page URL this step acted on. Evidence in its own right (a
   * multi-route flow was previously unattributable from the report alone), and
   * the join key the coverage ledger needs to mark the RIGHT route as
   * exercised — `report.url` is only the run's seed. */
  url?: string;
  console: ConsoleEntry[];
  network: NetworkEntry[];
  /** A24 Tier-0 oracle: deterministic invariant violations observed after this
   * step (rendered `undefined`, broken images, same-origin 4xx/5xx, duplicate
   * ids…). Evidence + prompt input only for now — these do NOT decide the
   * verdict until the oracle has been dogfooded against a real passing run
   * (A1), so enabling it cannot silently flip existing outcomes. */
  invariants?: InvariantViolation[];
  /** A2 (P0): named counters (today: the cart badge) read off the page
   * immediately before and after THIS action, captured only for the handful of
   * steps a count-delta relation could apply to (a landed add/remove click).
   * Comparing a badge across a whole run is meaningless — it only has to move
   * around the action that moves it. */
  countsBefore?: Record<string, number>;
  countsAfter?: Record<string, number>;
  visual?: NanoVerdict;
  screenshot?: string;
  video?: string;
  ts: number;
}

export interface FailingStep {
  index: number;
  action: Action;
  description: string;
}

/** Real token accounting for a run. The pitch in one object:
 *  - cheapModelTotal / cheapModelCached: what the FREE/cheap rungs (1+) actually
 *    spent doing the looking — measured from envelope/usageMetadata counts.
 *  - callsByRung: how many model calls landed on each rung (rung 0 = $0 Nano).
 *  - verdictPayloadTokens: what the EXPENSIVE calling agent pays — the slim
 *    5-field report it reads back (~chars/4). This is `tokenEstimate`'s meaning.
 *
 * Per-role split (planner/navigator architecture) — grouped from model_trace by
 * `capability`, this is the proof the split works: the smart BRAIN plans rarely
 * (plan-goals) while the cheap NAVIGATOR does every step (plan-step), so
 * brainCalls must NOT scale with step count.
 *  - navigatorCalls / navigatorTokens: plan-step (cheap, every step).
 *  - brainCalls / brainTokens: plan-goals (smart, rare — start + on stuck).
 *  - visualCalls: visual-verdict checks (Nano first, $0). */
export interface ReportTokens {
  cheapModelTotal: number;
  cheapModelCached: number;
  callsByRung: Record<number, number>;
  verdictPayloadTokens: number;
  navigatorCalls: number;
  brainCalls: number;
  visualCalls: number;
  navigatorTokens: number;
  brainTokens: number;
}

/** A5a (P1) safety: compact spend summary for the done/slim payload — lets the
 * panel render a "N free · M paid · ~$X spent" meter without walking
 * model_trace itself. freeCalls = rung-0 (on-device Nano, $0) calls; paidCalls
 * = every other model call (rung 1+ cloud/CLI, whether or not it reported
 * token usage). estimatedUsd is a PROXY, not real billing — see driver/loop.ts's
 * estimatedPaidSpendUsd for the approximation it makes. capUsd mirrors the
 * run's configured LoopOptions.spendCapUsd (absent when no cap was set). */
export interface SpendSummary {
  freeCalls: number;
  paidCalls: number;
  totalTokens: number;
  estimatedUsd: number;
  capUsd?: number;
}

export interface ActionCacheStats {
  enabled: boolean;
  hits: number;
  misses: number;
  stale: number;
  stored: number;
}

/** A21 (P2, reframed for autonomy): the outcome of classifying a `--heal`
 * candidate against the script it would replace (see
 * `src/recorder/heal-policy.ts`'s `classifyHeal`). Present only on a
 * `qaReplay` result that went through the heal path.
 *
 *  - 'auto'       the heal was accepted and saved exactly as before this
 *                 feature existed (locator-only drift; intent unchanged).
 *  - 'notice'     the heal was accepted and saved, but it added
 *                 navigation/wait-only steps — recorded here for audit-trail
 *                 visibility, not because anything needs reviewing.
 *  - 'quarantine' the heal was REJECTED: the OLD script stays active
 *                 untouched, the healed candidate is written alongside as
 *                 `candidatePath` (never overwriting the original), and the
 *                 run's `verdict` is reported as 'uncertain' rather than
 *                 'pass' — an unreviewed heal must never silently become the
 *                 suite's truth. See CLAUDE.md / the A21 design doc for why
 *                 this degrades to "unverified", never to green. */
export interface HealReview {
  tier: 'auto' | 'notice' | 'quarantine';
  reasons: string[];
  /** Set only when tier === 'quarantine': path of the healed-but-unaccepted
   * candidate script, saved next to (never over) the original. */
  candidatePath?: string;
}

export interface Report {
  // ---- slim contract: what the calling agent reads ----
  verdict: RunVerdict;
  failing_step: FailingStep | null;
  console_error: string | null;
  evidence_paths: string[];
  reason: string;
  // ---- full evidence: for humans ----
  runId: string;
  task: string;
  url: string;
  steps: StepRecord[];
  model_trace: ModelTraceEntry[];
  assertion_trace?: AssertionTraceEntry[];
  /** Non-secret per-run generated/extracted values such as run.email/orderId. */
  run_data?: RunDataState;
  action_cache?: ActionCacheStats;
  durationMs: number;
  /** What the expensive calling agent pays = tokens.verdictPayloadTokens. */
  tokenEstimate: number;
  /** Real token accounting (always set by the AI driver loop; absent on bare
   * replay reports, which have no planner trace). */
  tokens?: ReportTokens;
  /** A5a (P1) safety: compact spend summary (always set by the AI driver loop;
   * absent on bare replay reports, same convention as `tokens`). */
  spendSummary?: SpendSummary;
  /** A21: set only on a `qaReplay` result that went through `--heal`'s
   * classification step. See `HealReview` for what each tier means. */
  healReview?: HealReview;
  /** A30 (A24 Tier 1): the differential comparison against this flow's stored
   * baseline, when one existed. Absent on the first run of a flow (the baseline
   * is created instead) and when differential mode is off. Evidence only — like
   * the Tier-0 invariants, it does NOT decide the verdict until it has been
   * dogfooded long enough to know its false-positive rate on real UI churn. */
  /** A33 (A24 Tier 2): metamorphic relations that the app's shape SUGGESTS are
   * checkable here (a cart badge implies add-item-increments-count, a paginator
   * implies pages-are-disjoint). Suggestions only, and deliberately so:
   * EXECUTING a relation needs paired observations from two deliberately-varied
   * runs, which the single-run driver cannot produce. Surfacing them is the
   * input to the "AI proposes once, then it runs deterministically forever"
   * workflow — recording the proposal is the honest half that exists today. */
  metamorphicCandidates?: { relation: string; reason: string }[];
  differential?: {
    mode: 'baseline' | 'environment';
    clean: boolean;
    axChanges: number;
    networkChanges: number;
    detail: string[];
  };
}

/** The verdict an MCP/CLI caller pays for, plus (A5a) a compact spend summary
 * so the panel can render a meter without re-deriving it from model_trace. */
export function slimReport(r: Report): Pick<Report, 'verdict' | 'failing_step' | 'console_error' | 'evidence_paths' | 'reason' | 'spendSummary'> {
  return {
    verdict: r.verdict,
    failing_step: r.failing_step,
    console_error: r.console_error,
    evidence_paths: r.evidence_paths,
    reason: r.reason,
    spendSummary: r.spendSummary,
  };
}

export function describeAction(a: Action): string {
  switch (a.type) {
    case 'navigate':
      return `navigate to ${a.url}`;
    case 'click':
      return `click ${a.nodeId}`;
    case 'type':
      return `type ${JSON.stringify(a.text)} into ${a.nodeId}`;
    case 'hover':
      return `hover ${a.nodeId}`;
    case 'press_key':
      return `press key ${a.key}`;
    case 'select_option':
      return `select ${JSON.stringify(a.value)} in ${a.nodeId}`;
    case 'reload':
      return 'reload page';
    case 'go_back':
      return 'go back';
    case 'assert_visual':
      return `${a.mode === 'video' ? 'video' : 'visual'} check: ${a.expectation}`;
    case 'assert_dom':
      return `dom check: ${a.nodeId} contains ${JSON.stringify(a.contains)}`;
    case 'assert_text':
      return `text check: ${a.target ?? 'page'} ${a.mode} ${JSON.stringify(a.value)}`;
    case 'assert_count':
      return `count check: ${a.role}${a.name ? ` "${a.name}"` : ''} ${a.comparator} ${a.expected}`;
    case 'assert_url':
      return `url check: ${a.mode} ${JSON.stringify(a.value)}`;
    case 'assert_state':
      return `state check: ${a.target} is ${a.state}`;
    case 'assert_network':
      return `network check: ${a.urlPattern}${a.status !== undefined ? ` status=${a.status}` : a.statusClass ? ` status=${a.statusClass}` : ''}${a.absent ? ' (must be absent)' : ''}`;
    case 'assert_no_console_errors':
      return `console check: no errors${a.allow?.length ? ` (allowing ${a.allow.length} pattern(s))` : ''}`;
    case 'extract':
      return `extract ${a.key} from ${a.nodeId ?? 'page'}${a.prompt ? ' (model)' : a.pattern ? ` matching ${JSON.stringify(a.pattern)}` : ''}`;
    case 'wait_for_email':
      return `wait for email${a.matching ? ` matching ${JSON.stringify(a.matching)}` : ''}${a.extractOtpTo ? ` → extract OTP to ${a.extractOtpTo}` : ''}`;
    case 'upload_file':
      return `upload ${a.paths.length} file(s) to ${a.nodeId}`;
    case 'drag_and_drop':
      return `drag ${a.sourceId} onto ${a.targetId}`;
    case 'blur':
      return `blur ${a.nodeId}`;
    case 'mouse':
      return `mouse ${a.kind} at (${a.x}, ${a.y})`;
    case 'open_tab':
      return `open tab ${a.url}`;
    case 'switch_tab':
      return `switch to tab ${a.tabId}`;
    case 'close_tab':
      return `close tab ${a.tabId}`;
    case 'script':
      return `run script (${a.steps.length} step${a.steps.length === 1 ? '' : 's'})`;
    case 'wait':
      return `wait ${a.ms}ms`;
    case 'finish':
      return `finish: ${a.verdict} — ${a.reason}`;
  }
}
