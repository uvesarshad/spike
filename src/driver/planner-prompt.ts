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

Decide the next 1-3 actions. Rules:
- Interact via nodeIds from the tree above (click/type). nodeIds change every step — only use ids from THIS tree.
- typing into a field REPLACES its content; no need to clear first.
- Use assert_dom (free) to check visible text; use assert_visual ONLY when correctness must be judged from how the page looks (layout, error banners, missing content).
- Console errors / failed network requests after an action are strong evidence the app is broken — investigate or finish with verdict "fail" and cite them.
- If the page shows an error message after your action (e.g. "Invalid email or password"), do NOT retry the same input — the input is wrong. finish with verdict "fail" and quote the visible error so the user can correct their task.
- When the task is demonstrably complete, action finish with verdict "pass". If the app is broken such that the task cannot complete, finish with verdict "fail" and a precise reason.
- Do not repeat an action that already failed twice.

BATCHING: PREFER returning 2-3 actions when you are confident they are independent of each other's outcomes — this is much faster. The actions run in order against THIS tree. Examples:
- fill several fields then click submit: [type email, type password, click "Sign in"].
- act on the page then move on: [click "Add Widget to cart", click "Go to cart"] — the add-to-cart click updates the page in place; the navigating click goes LAST.
Rules:
- After any action that navigates or could meaningfully change the page (a click that submits a form or navigates, or a navigate action), the remaining actions in your batch are DISCARDED and you will be asked again with the new page. So the ONLY navigating/submitting action in a batch must be the LAST one; everything before it must keep you on the same page.
- finish, assert_visual and assert_dom must be the ONLY action in their batch (return exactly one action).
- When unsure whether an earlier action changes the page, return a single action.

Action types:
- {"type":"navigate","url":string}
- {"type":"click","nodeId":string}
- {"type":"type","nodeId":string,"text":string}
- {"type":"assert_dom","nodeId":string,"contains":string}   // cheap text check
- {"type":"assert_visual","expectation":string}             // screenshot judged by a vision model
- {"type":"wait","ms":number}
- {"type":"finish","verdict":"pass"|"fail","reason":string}

Respond with ONLY JSON: {"thought": "<one short sentence>", "actions": [{...}, ...]}
Example: {"thought":"Fill the login form and submit it.","actions":[{"type":"type","nodeId":"n4","text":"test@test.com"},{"type":"type","nodeId":"n6","text":"pw"},{"type":"click","nodeId":"n8"}]}`;
}
