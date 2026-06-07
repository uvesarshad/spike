/* The driver loop — a11y-tree-first, vision on demand.
 *
 * Per step: snapshot tree → planner picks ONE action → execute via the port →
 * drain console/network into the step record (exact per-step correlation).
 * Policies: step budget → uncertain; invalid planner JSON → one retry with the
 * validation error; action throw → one retry after re-resolving the target by
 * role+name in a fresh tree; same action 3× → uncertain; visual fail → run
 * fails; finish:pass → one confirmation visual before accepting. */

import type { AxNode, AxSnapshot, BrowserPort } from '../ports/browser-port.js';
import { firstError } from '../capture/console-network.js';
import type { ModelRouter } from '../router/model-router.js';
import type { ArtifactStore } from '../report/artifacts.js';
import { describeAction, type FailingStep, type Report, type StepRecord, type RunVerdict } from '../report/report.js';
import { PLAN_JSON_SCHEMA, PlanResultSchema, type Action, type PlanResult } from './actions.js';
import { buildPlannerPrompt } from './planner-prompt.js';
import type { Vault } from '../vault/vault.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
export type StepKind = 'plan' | 'click' | 'type' | 'navigate' | 'assert' | 'wait' | 'finish';
export interface StepInfo {
  index: number;
  kind: StepKind;
  text: string;
  ok?: boolean;
}

export interface LoopOptions {
  maxSteps: number;
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
}

/** Map an action to its onStep kind. */
function stepKind(action: Action): StepKind {
  switch (action.type) {
    case 'click':
      return 'click';
    case 'type':
      return 'type';
    case 'navigate':
      return 'navigate';
    case 'wait':
      return 'wait';
    case 'finish':
      return 'finish';
    case 'assert_visual':
    case 'assert_dom':
      return 'assert';
  }
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
    case 'navigate':
      return `Navigate to ${action.url}`;
    case 'wait':
      return `Wait ${action.ms}ms`;
    case 'finish':
      return `Finish: ${action.verdict} — ${action.reason}`;
    case 'assert_visual':
      return `Visual check: ${action.expectation}`;
    case 'assert_dom':
      return `Check ${tgt ?? action.nodeId} contains "${action.contains}"`;
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

  await browser.navigate(url);
  browser.drainConsole();
  browser.drainNetwork(); // initial page load noise is not step evidence

  let stepIndex = 0; // running index across batches, bounded by maxSteps
  let lastBatchFirstSig: string | null = null; // for loop detection
  let lastSnapshotAx: AxSnapshot | null = null; // last tree text, for the uncertain-reason heuristic
  let done = false;

  // each outer iteration = ONE planner call → a batch of 1-3 actions
  while (stepIndex < opts.maxSteps && !done) {
    if (signal?.aborted) {
      reason = 'cancelled by user';
      break;
    }
    const ax = await browser.axTree();
    lastSnapshotAx = ax;
    const batchUrl = await browser.url();

    // ---- plan ----
    onStep({ index: stepIndex, kind: 'plan', text: 'Planning next step…' });
    let plan: PlanResult;
    try {
      plan = await planOnce(router, {
        prompt: buildPlannerPrompt({
          task,
          url: batchUrl,
          axText: ax.text,
          history: steps,
          stepIndex,
          maxSteps: opts.maxSteps,
        }),
        step: stepIndex,
      });
    } catch (e) {
      reason = `planner failed: ${e instanceof Error ? e.message : e}`;
      break;
    }

    let actions = plan.actions;
    // finish / asserts must be alone in their batch — if the model bundled
    // extras, keep only the first action (these never batch)
    if (actions[0].type === 'finish' || actions[0].type === 'assert_visual' || actions[0].type === 'assert_dom') {
      actions = [actions[0]];
    }

    // ---- loop detection ----
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
      reason = `planner repeated the same action 3×: ${describeAction(actions[0])}` +
        (visibleErr ? ` — page shows: "${visibleErr}" (likely the real cause)` : '');
      break;
    }
    lastBatchFirstSig = firstSig;

    // ---- execute the batch, one StepRecord + drain per action ----
    let aborted = false;
    let readOnlyBlock: string | null = null; // set when a mutation hits a non-allowed host
    for (let a = 0; a < actions.length && stepIndex < opts.maxSteps; a++) {
      const action = actions[a];

      if (signal?.aborted) {
        aborted = true;
        reason = 'cancelled by user';
        break;
      }

      // ---- read-only-by-default guard: mutations (click/type) only on allowed
      // hosts. Check the LIVE page host, not batchUrl — an earlier action in the
      // batch may have navigated us elsewhere. navigate/assert/wait stay allowed.
      if (action.type === 'click' || action.type === 'type') {
        const host = hostOf(await browser.url());
        if (host && !hostAllowed(host, allowedHosts)) {
          readOnlyBlock = host;
          break;
        }
      }

      const i = stepIndex++;

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
      // run replayable later; nodeIds die with the snapshot
      if ('nodeId' in action) {
        const t = findNode(ax.root, action.nodeId);
        if (t) record.target = { role: t.role, ...(t.name && { name: t.name }) };
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
          const resolved = resolveSecrets(action.text, vault);
          await executeWithRetry(browser, { ...action, text: resolved }, ax.root);
        } else {
          await executeWithRetry(browser, action, ax.root);
        }
      } catch (e) {
        record.ok = false;
        record.error = e instanceof Error ? e.message : String(e);
      }

      await sleep(150); // let async fallout (fetches, navigations) land
      record.console = browser.drainConsole();
      record.network = browser.drainNetwork();

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
        text: humanizeAction(action, record.target),
        ok: record.ok,
      });

      // a finish or a settled verdict ends the whole run
      if (verdict !== 'uncertain' || action.type === 'finish') {
        done = true;
        break;
      }

      // ---- batch abort conditions: stop running the REST of the batch when
      // an action failed, a drain shows a page-error, or the URL changed ----
      if (a < actions.length - 1) {
        if (!record.ok) break;
        if (drainHasPageError(record.console, record.network)) break;
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
    tokens: { cheapModelTotal: 0, cheapModelCached: 0, callsByRung: {}, verdictPayloadTokens: 0 },
  };
  report.evidence_paths = [
    ...steps.filter((s) => s.screenshot).map((s) => s.screenshot!),
  ];
  const reportPath = artifacts.saveReport(report);
  report.evidence_paths.unshift(reportPath);
  const tokens = computeTokens(report);
  report.tokens = tokens;
  // tokenEstimate keeps its product-doc meaning: what the calling agent pays.
  report.tokenEstimate = tokens.verdictPayloadTokens;
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

/** Real token accounting. cheapModel* sum the measured per-call usage in the
 * trace (the FREE/cheap-rung spend doing the looking); callsByRung counts every
 * model call (rung 0 = $0 on-device Nano, whose tokens are irrelevant);
 * verdictPayloadTokens = the slim 5-field report the EXPENSIVE caller reads back
 * (~chars/4) — what the calling agent actually pays. */
function computeTokens(r: Report): NonNullable<Report['tokens']> {
  let cheapModelTotal = 0;
  let cheapModelCached = 0;
  const callsByRung: Record<number, number> = {};
  for (const t of r.model_trace) {
    callsByRung[t.rung] = (callsByRung[t.rung] ?? 0) + 1;
    if (t.usage?.totalTokens) cheapModelTotal += t.usage.totalTokens;
    if (t.usage?.cachedTokens) cheapModelCached += t.usage.cachedTokens;
  }
  const verdictPayloadTokens = Math.ceil(
    JSON.stringify(r.steps.length ? slimForEstimate(r) : {}).length / 4,
  );
  return { cheapModelTotal, cheapModelCached, callsByRung, verdictPayloadTokens };
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

/** A redacted target string for the audit log: the touched node's role+name,
 * or the navigate url, or undefined. NEVER includes resolved secret values
 * (a type action's text — which may carry the {{secret:…}} placeholder — is
 * deliberately not logged as the target). */
function auditTarget(action: Action, target?: { role: string; name?: string }): string | undefined {
  if (action.type === 'navigate') return action.url;
  if (target) return target.name ? `${target.role} "${target.name}"` : target.role;
  return undefined;
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
