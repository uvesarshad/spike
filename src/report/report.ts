/* report.json — the product's contract. The first four fields are exactly what
 * the calling LLM reads (~2K tokens, product doc §6); everything after is for
 * humans and debugging. */

import type { ConsoleEntry, NetworkEntry } from '../ports/browser-port.js';
import type { NanoVerdict } from '../ports/nano-port.js';
import type { Action } from '../driver/actions.js';
import type { ModelTraceEntry } from '../router/model-router.js';

export type RunVerdict = 'pass' | 'fail' | 'uncertain';

export interface StepRecord {
  index: number;
  thought?: string;
  action: Action;
  description: string;
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
  tokenEstimate: number;
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
