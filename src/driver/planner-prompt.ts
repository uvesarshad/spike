/* Planner prompt — everything the rung-1/2 brain sees each step. Token shape
 * matters: the a11y tree (~800 tok) is the page; console/network only when
 * noteworthy; history compressed to one line per step. */

import type { ConsoleEntry, NetworkEntry } from '../ports/browser-port.js';
import type { StepRecord } from '../report/report.js';

export interface PlannerContext {
  task: string;
  url: string;
  axText: string;
  history: StepRecord[];
  stepIndex: number;
  maxSteps: number;
}

const MAX_EVIDENCE_LINES = 8;

function consoleLines(entries: ConsoleEntry[]): string[] {
  return entries
    .filter((e) => e.level === 'error' || e.level === 'page-error' || e.level === 'warn')
    .slice(-MAX_EVIDENCE_LINES)
    .map((e) => `console.${e.level}: ${e.text.slice(0, 200)}`);
}

function networkLines(entries: NetworkEntry[]): string[] {
  return entries
    .filter((e) => e.failed)
    .slice(-MAX_EVIDENCE_LINES)
    .map((e) => `net: ${e.method} ${e.url} → ${e.status ?? e.errorText ?? 'failed'}`);
}

export function buildPlannerPrompt(ctx: PlannerContext): string {
  const historyLines = ctx.history.map((s) => {
    const bits = [`${s.index}. ${s.description} → ${s.ok ? 'ok' : `FAILED: ${s.error ?? 'unknown'}`}`];
    bits.push(...consoleLines(s.console).map((l) => `   ${l}`));
    bits.push(...networkLines(s.network).map((l) => `   ${l}`));
    if (s.visual) bits.push(`   visual verdict: ${s.visual.verdict} — ${s.visual.summary.slice(0, 150)}`);
    return bits.join('\n');
  });

  return `You are a browser QA agent. You control a real Chrome page one action at a time.

TASK: ${ctx.task}

CURRENT URL: ${ctx.url}
STEP: ${ctx.stepIndex + 1} of max ${ctx.maxSteps}

CURRENT PAGE (accessibility tree; nodeIds like n7 are what you reference in actions):
${ctx.axText}

${ctx.history.length ? `ACTIONS SO FAR (with any errors/console/network evidence they caused):\n${historyLines.join('\n')}` : 'No actions taken yet.'}

Decide the SINGLE next action. Rules:
- Interact via nodeIds from the tree above (click/type). nodeIds change every step — only use ids from THIS tree.
- type() replaces the field content; no need to clear first.
- Use assert_dom (free) to check visible text; use assert_visual ONLY when correctness must be judged from how the page looks (layout, error banners, missing content).
- Console errors / failed network requests after an action are strong evidence the app is broken — investigate or finish with verdict "fail" and cite them.
- When the task is demonstrably complete, action finish with verdict "pass". If the app is broken such that the task cannot complete, finish with verdict "fail" and a precise reason.
- Do not repeat an action that already failed twice.

Action types:
- {"type":"navigate","url":string}
- {"type":"click","nodeId":string}
- {"type":"type","nodeId":string,"text":string}
- {"type":"assert_dom","nodeId":string,"contains":string}   // cheap text check
- {"type":"assert_visual","expectation":string}             // screenshot judged by a vision model
- {"type":"wait","ms":number}
- {"type":"finish","verdict":"pass"|"fail","reason":string}

Respond with ONLY JSON: {"thought": "<one short sentence>", "action": {...}}
Example: {"thought":"The login form is filled, submit it.","action":{"type":"click","nodeId":"n12"}}`;
}
