/* The driver loop — a11y-tree-first, vision on demand.
 *
 * Per step: snapshot tree → planner picks ONE action → execute via the port →
 * drain console/network into the step record (exact per-step correlation).
 * Policies: step budget → uncertain; invalid planner JSON → one retry with the
 * validation error; action throw → one retry after re-resolving the target by
 * role+name in a fresh tree; same action 3× → uncertain; visual fail → run
 * fails; finish:pass → one confirmation visual before accepting. */

import type { AxNode, BrowserPort } from '../ports/browser-port.js';
import { firstError } from '../capture/console-network.js';
import type { ModelRouter } from '../router/model-router.js';
import type { ArtifactStore } from '../report/artifacts.js';
import { describeAction, type FailingStep, type Report, type StepRecord, type RunVerdict } from '../report/report.js';
import { PLAN_JSON_SCHEMA, PlanResultSchema, type Action, type PlanResult } from './actions.js';
import { buildPlannerPrompt } from './planner-prompt.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface LoopOptions {
  maxSteps: number;
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

  await browser.navigate(url);
  browser.drainConsole();
  browser.drainNetwork(); // initial page load noise is not step evidence

  for (let i = 0; i < opts.maxSteps; i++) {
    const ax = await browser.axTree();
    const currentUrl = await browser.url();

    // ---- plan ----
    let plan: PlanResult;
    try {
      plan = await planOnce(router, {
        prompt: buildPlannerPrompt({
          task,
          url: currentUrl,
          axText: ax.text,
          history: steps,
          stepIndex: i,
          maxSteps: opts.maxSteps,
        }),
        step: i,
      });
    } catch (e) {
      reason = `planner failed: ${e instanceof Error ? e.message : e}`;
      break;
    }
    const action = plan.action;

    // ---- loop detection ----
    const sig = JSON.stringify(action);
    if (steps.length >= 2 && steps.slice(-2).every((s) => JSON.stringify(s.action) === sig)) {
      reason = `planner repeated the same action 3×: ${describeAction(action)}`;
      break;
    }

    const record: StepRecord = {
      index: i,
      thought: plan.thought,
      action,
      description: describeAction(action),
      ok: true,
      console: [],
      network: [],
      ts: Date.now(),
    };
    // remember WHAT the action touches (role+name) — this is what makes the
    // run replayable later; nodeIds die with the snapshot
    if ('nodeId' in action) {
      const target = findNode(ax.root, action.nodeId);
      if (target) record.target = { role: target.role, ...(target.name && { name: target.name }) };
    }
    steps.push(record);

    // ---- execute ----
    try {
      if (action.type === 'finish') {
        // trust a fail immediately; confirm a pass with one visual check
        if (action.verdict === 'fail') {
          verdict = 'fail';
          reason = action.reason;
          failingStep = lastInteraction(steps) ?? { index: i, action, description: record.description };
        } else {
          const png = await browser.screenshot();
          record.screenshot = artifacts.saveScreenshot(i, png);
          const confirm = await router.visualVerdict(
            png,
            `The task "${task}" should have completed successfully. Does the page show a sensible end state for it (no error banners, no blank page)?`,
            i,
          );
          record.visual = confirm;
          if (confirm.verdict === 'fail') {
            verdict = 'fail';
            reason = `planner claimed success but the confirmation visual check failed: ${confirm.summary}`;
            failingStep = { index: i, action, description: record.description };
          } else {
            verdict = 'pass';
            reason = action.reason;
          }
        }
      } else if (action.type === 'assert_visual') {
        const png = await browser.screenshot();
        record.screenshot = artifacts.saveScreenshot(i, png);
        const v = await router.visualVerdict(png, action.expectation, i);
        record.visual = v;
        if (v.verdict === 'fail') {
          verdict = 'fail';
          reason = `visual assertion failed: ${v.summary}${v.issues.length ? ` — ${v.issues.join('; ')}` : ''}`;
          failingStep = { index: i, action, description: record.description };
        }
      } else if (action.type === 'assert_dom') {
        const target = findNode(ax.root, action.nodeId);
        const hay = target ? subtreeText(target) : '';
        if (!target) {
          record.ok = false;
          record.error = `nodeId ${action.nodeId} not in current tree`;
        } else if (!hay.toLowerCase().includes(action.contains.toLowerCase())) {
          record.ok = false;
          record.error = `expected ${JSON.stringify(action.contains)} in ${action.nodeId}, found: ${hay.slice(0, 150)}`;
        }
      } else {
        await executeWithRetry(browser, action, ax.root);
      }
    } catch (e) {
      record.ok = false;
      record.error = e instanceof Error ? e.message : String(e);
    }

    await sleep(250); // let async fallout (fetches, navigations) land
    record.console = browser.drainConsole();
    record.network = browser.drainNetwork();

    if (verdict !== 'uncertain' || action.type === 'finish') break;
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
    durationMs: Date.now() - t0,
    tokenEstimate: 0,
  };
  report.evidence_paths = [
    ...steps.filter((s) => s.screenshot).map((s) => s.screenshot!),
  ];
  const reportPath = artifacts.saveReport(report);
  report.evidence_paths.unshift(reportPath);
  report.tokenEstimate = Math.round(JSON.stringify(report.steps.length ? slimForEstimate(report) : {}).length / 4);
  artifacts.saveReport(report); // rewrite with final paths + estimate
  return report;
}

function slimForEstimate(r: Report) {
  return {
    verdict: r.verdict,
    failing_step: r.failing_step,
    console_error: r.console_error,
    evidence_paths: r.evidence_paths,
    reason: r.reason,
  };
}

/* ---------- planning ---------- */

async function planOnce(
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
  throw new Error(`planner returned invalid actions twice: ${retry.error.message.slice(0, 200)}`);
}

/* ---------- execution ---------- */

async function executeWithRetry(browser: BrowserPort, action: Action, planTree: AxNode): Promise<void> {
  try {
    await executeOnce(browser, action);
  } catch (firstErr) {
    // DOM may have shifted between snapshot and execution: re-resolve the
    // target by role+name in a FRESH tree and retry once
    if (action.type !== 'click' && action.type !== 'type') throw firstErr;
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
    case 'wait':
      return sleep(action.ms);
    default:
      throw new Error(`executeOnce: unexpected action ${action.type}`);
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

function lastInteraction(steps: StepRecord[]): FailingStep | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.action.type === 'click' || s.action.type === 'type' || s.action.type === 'navigate') {
      return { index: s.index, action: s.action, description: s.description };
    }
  }
  return null;
}
