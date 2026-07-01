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

/** One line per step + any error/console/network/visual evidence it caused.
 * Shared by every prompt so history reads identically across roles. */
function formatHistory(history: StepRecord[]): string {
  return history
    .map((s) => {
      const bits = [`${s.index}. ${s.description} → ${s.ok ? 'ok' : `FAILED: ${s.error ?? 'unknown'}`}`];
      bits.push(...consoleLines(s.console).map((l) => `   ${l}`));
      bits.push(...networkLines(s.network).map((l) => `   ${l}`));
      if (s.visual) bits.push(`   visual verdict: ${s.visual.verdict} — ${s.visual.summary.slice(0, 150)}`);
      return bits.join('\n');
    })
    .join('\n');
}

/** Mark the current goal with → and number the rest. */
function goalChecklist(goals: string[], currentGoal: number): string {
  return goals.map((g, i) => `${i === currentGoal ? '→' : ' '} ${i + 1}. ${g}`).join('\n');
}

export function buildPlannerPrompt(ctx: PlannerContext): string {
  const historyLines = ctx.history.length ? formatHistory(ctx.history) : '';

  return `You are a browser QA agent. You control a real Chrome page one action at a time.

TASK: ${ctx.task}

CURRENT URL: ${ctx.url}
STEP: ${ctx.stepIndex + 1} of max ${ctx.maxSteps}

CURRENT PAGE (accessibility tree; nodeIds like n7 are what you reference in actions):
${ctx.axText}

${historyLines ? `ACTIONS SO FAR (with any errors/console/network evidence they caused):\n${historyLines}` : 'No actions taken yet.'}

Decide the next 1-3 actions. Rules:
- Interact via nodeIds from the tree above (click/type). nodeIds change every step — only use ids from THIS tree.
- typing into a field REPLACES its content; no need to clear first.
- Use assert_dom (free) to check visible text; use assert_visual ONLY when correctness must be judged from how the page looks (layout, error banners, missing content).
- Console errors / failed network requests after an action are strong evidence the app is broken — investigate or finish with verdict "fail" and cite them.
- If the page shows an error message after your action (e.g. "Invalid email or password"), do NOT retry the same input — the input is wrong. finish with verdict "fail" and quote the visible error so the user can correct their task.
- When the task is demonstrably complete, action finish with verdict "pass". If the app is broken such that the task cannot complete, finish with verdict "fail" and a precise reason.
- Do not repeat an action that already failed twice.
- If the task references a stored secret like {{secret:NAME}}, pass that placeholder VERBATIM as the text of a type action — never invent its value.

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

/* ------------------------------------------------------------------------- *
 * Planner/navigator split. The BRAIN (buildGoalPlannerPrompt) makes/repairs an
 * ordered sub-goal checklist; it never drives the page. The NAVIGATOR
 * (buildNavigatorPrompt) executes ONE goal at a time with the same action
 * vocabulary the single-tier planner used, plus goalComplete/blocked signals.
 * ------------------------------------------------------------------------- */

export interface GoalPlannerContext {
  task: string;
  url: string;
  axText: string;
  history?: StepRecord[];
  /** The plan the navigator was following (present on an escalation re-plan). */
  goals?: string[];
  /** Index into `goals` the navigator was stuck on (present on escalation). */
  currentGoal?: number;
  /** Why the navigator escalated (present on escalation). */
  failure?: string;
}

/** The BRAIN prompt. First call: task + current page → an ordered sub-goal
 * checklist. Escalation call (failure/goals/currentGoal present): decide how to
 * unblock — revised remaining goals, a hint for the navigator, or a final verdict. */
export function buildGoalPlannerPrompt(ctx: GoalPlannerContext): string {
  const escalating = !!(ctx.failure || ctx.goals?.length || ctx.currentGoal !== undefined);
  const checklist = ctx.goals?.length ? goalChecklist(ctx.goals, ctx.currentGoal ?? 0) : '';
  const historyLines = ctx.history?.length ? formatHistory(ctx.history) : '';

  return `You are the PLANNER (the "brain") of a browser QA agent. You do NOT drive the page yourself — a separate NAVIGATOR clicks, types, and looks at the page to carry out each goal you set. Your job is to turn the task into an ordered checklist of concrete sub-goals the navigator can execute one at a time.

TASK: ${ctx.task}

CURRENT URL: ${ctx.url}

CURRENT PAGE (accessibility tree; the navigator references nodeIds like n7 — you do not):
${ctx.axText}
${
  escalating
    ? `
The navigator is STUCK and has escalated to you.
${checklist ? `PLAN SO FAR (→ marks the goal it was on):\n${checklist}\n` : ''}${ctx.failure ? `WHY IT STOPPED: ${ctx.failure}\n` : ''}${historyLines ? `ACTIONS SO FAR (with any errors/console/network evidence):\n${historyLines}\n` : ''}
Decide how to unblock the run — return ONE of:
- REVISED remaining "goals": drop the ones already done and rewrite the rest so the navigator can succeed.
- a short "hint": tell the navigator how to get past the current goal (the plan stands).
- a "verdict" ("pass" or "fail") with a "reason": use this only if the task is already complete or is genuinely impossible from here.
`
    : `
Produce an ordered checklist of sub-goals. Rules:
- Each goal is ONE concrete outcome the navigator can achieve (e.g. "log in with the given credentials", "add the widget to the cart", "reach the order confirmation").
- Keep the list short — usually 2-6 goals — in the order they must happen.
- The last goal must be the one that proves the task is done.
- Do NOT reference nodeIds or individual clicks; those are the navigator's job.
`
}
Respond with ONLY JSON: {"thought":"<one short sentence>","goals":["...","..."]}
${
  escalating
    ? 'Instead of "goals" you may return {"thought":"...","hint":"..."} or {"thought":"...","verdict":"pass"|"fail","reason":"..."}.'
    : 'Or, if the task is impossible from here, return {"thought":"...","verdict":"fail","reason":"..."}.'
}`;
}

export interface NavigatorContext {
  task: string;
  url: string;
  axText: string;
  /** The one goal to work on this step. */
  goal: string;
  /** The full checklist for context (the current goal is marked). */
  goals: string[];
  currentGoal: number;
  history: StepRecord[];
  stepIndex: number;
  maxSteps: number;
  /** Optional planner hint from the last escalation. */
  hint?: string;
}

/** The NAVIGATOR prompt. Same action vocabulary + batching rules as the original
 * single-tier planner, focused on the CURRENT GOAL, with goalComplete/blocked
 * signals so the brain is consulted only when needed. */
export function buildNavigatorPrompt(ctx: NavigatorContext): string {
  const checklist = goalChecklist(ctx.goals, ctx.currentGoal);
  const historyLines = ctx.history.length ? formatHistory(ctx.history) : '';

  return `You are the NAVIGATOR of a browser QA agent. You control a real Chrome page one step at a time to carry out the CURRENT GOAL the planner gave you.

TASK: ${ctx.task}

CURRENT GOAL: ${ctx.goal}
GOAL CHECKLIST (→ is the one you are on now):
${checklist}
${ctx.hint ? `\nPLANNER HINT: ${ctx.hint}\n` : ''}
CURRENT URL: ${ctx.url}
STEP: ${ctx.stepIndex + 1} of max ${ctx.maxSteps}

CURRENT PAGE (accessibility tree; nodeIds like n7 are what you reference in actions):
${ctx.axText}

${historyLines ? `ACTIONS SO FAR (with any errors/console/network evidence they caused):\n${historyLines}` : 'No actions taken yet.'}

Work on the CURRENT GOAL. Decide the next 1-3 actions. Rules:
- Interact via nodeIds from the tree above (click/type). nodeIds change every step — only use ids from THIS tree.
- typing into a field REPLACES its content; no need to clear first.
- Use assert_dom (free) to check visible text; use assert_visual ONLY when correctness must be judged from how the page looks (layout, error banners, missing content).
- Console errors / failed network requests after an action are strong evidence the app is broken — investigate or finish with verdict "fail" and cite them.
- If the page shows an error message after your action (e.g. "Invalid email or password"), do NOT retry the same input — the input is wrong. finish with verdict "fail" and quote the visible error so the user can correct their task.
- When the task is demonstrably complete, action finish with verdict "pass". If the app is broken such that the task cannot complete, finish with verdict "fail" and a precise reason.
- Do not repeat an action that already failed twice.
- If the task references a stored secret like {{secret:NAME}}, pass that placeholder VERBATIM as the text of a type action — never invent its value.
- Return goalComplete: true (INSTEAD of actions) when the CURRENT GOAL is already satisfied by the page — the planner then advances you to the next goal.
- Return blocked: "<reason>" (INSTEAD of actions) when the page shows an error that stops progress or you cannot proceed — do NOT repeat a failed action; the planner will re-plan.

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

Respond with ONLY JSON, ONE of:
- {"thought":"<one short sentence>","actions":[{...}, ...]}
- {"thought":"<one short sentence>","goalComplete":true}
- {"thought":"<one short sentence>","blocked":"<reason>"}
Example: {"thought":"Fill the login form and submit it.","actions":[{"type":"type","nodeId":"n4","text":"test@test.com"},{"type":"type","nodeId":"n6","text":"pw"},{"type":"click","nodeId":"n8"}]}`;
}
