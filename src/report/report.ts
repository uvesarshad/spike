/* report.json — the product's contract. The first four fields are exactly what
 * the calling LLM reads (~2K tokens, product doc §6); everything after is for
 * humans and debugging. */

import type { ConsoleEntry, NetworkEntry } from '../ports/browser-port.js';
import type { NanoVerdict } from '../ports/nano-port.js';
import type { Action } from '../driver/actions.js';
import type { ModelTraceEntry } from '../router/model-router.js';

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
  console: ConsoleEntry[];
  network: NetworkEntry[];
  visual?: NanoVerdict;
  screenshot?: string;
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
  durationMs: number;
  /** What the expensive calling agent pays = tokens.verdictPayloadTokens. */
  tokenEstimate: number;
  /** Real token accounting (always set by the AI driver loop; absent on bare
   * replay reports, which have no planner trace). */
  tokens?: ReportTokens;
}

/** The 5-field verdict an MCP/CLI caller pays for. */
export function slimReport(r: Report): Pick<Report, 'verdict' | 'failing_step' | 'console_error' | 'evidence_paths' | 'reason'> {
  return {
    verdict: r.verdict,
    failing_step: r.failing_step,
    console_error: r.console_error,
    evidence_paths: r.evidence_paths,
    reason: r.reason,
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
      return `visual check: ${a.expectation}`;
    case 'assert_dom':
      return `dom check: ${a.nodeId} contains ${JSON.stringify(a.contains)}`;
    case 'wait':
      return `wait ${a.ms}ms`;
    case 'finish':
      return `finish: ${a.verdict} — ${a.reason}`;
  }
}
