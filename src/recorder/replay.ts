/* Replay — execute a recorded QaScript deterministically over CDP.
 *
 * Zero planner calls. Visual assertions run on Gemini Nano only (it's $0);
 * when Nano is unavailable they are skipped with a warning rather than
 * spending paid tokens — replays must stay free.
 *
 * Strictness: an element that can't be found (UI drift), a failed assertion,
 * an uncaught page error, or a 5xx during a step all fail the replay — a
 * failing replay is exactly the regression signal the recorder exists for. */

import type { AxNode, BrowserPort } from '../ports/browser-port.js';
import type { NanoPort } from '../ports/nano-port.js';
import { firstError } from '../capture/console-network.js';
import type { ArtifactStore } from '../report/artifacts.js';
import type { FailingStep, Report, RunVerdict, StepRecord } from '../report/report.js';
import type { LocatorCandidate, QaScript, ScriptStep, ScriptTarget } from './script.js';
import { candidateStackFor } from './script.js';
import { createRunDataState, recordExtraction, resolveRunPlaceholders } from '../run-data/index.js';
import { validateScriptSteps, runScriptSteps } from '../driver/script-runner/index.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const FIND_TIMEOUT_MS = 5_000;

/** A12 (P0): the one-method shape replay needs from a secrets store — mirrors
 * driver/loop.ts's SecretsSource (kept as its own tiny interface rather than a
 * cross-module import so recorder/ doesn't need to depend on driver/'s
 * SecretsSource just for this). The real `Vault` (src/vault/vault.ts)
 * satisfies this structurally, and so does a plain test double. */
export interface ReplaySecretsSource {
  get(name: string): string | undefined;
}

import { resolveTotpPlaceholders } from '../auth/totp.js';

/** {{secret:NAME}} — NAME is [a-zA-Z0-9_-]+. Mirrors driver/loop.ts's SECRET_RE. */
const SECRET_PLACEHOLDER_RE = /\{\{secret:([a-zA-Z0-9_-]+)\}\}/g;

/** A12 (P0): thrown when a recorded `type` step's `{{secret:NAME}}` can't be
 * resolved (no vault passed, or the vault doesn't hold NAME). Deliberately a
 * distinct, named error — a missing secret is a setup problem ("you never
 * saved this credential"), not a UI regression, so `isMissingSecretFailure`
 * below lets a caller (qaRun's replay-fallback decision) recognize it and
 * skip the silent "fall back to a paid AI run" path that every other replay
 * failure gets. */
export class MissingSecretError extends Error {
  constructor(readonly secretName: string) {
    super(`missing secret ${secretName} — run: spike secret set ${secretName}`);
    this.name = 'MissingSecretError';
  }
}

/** Resolve any {{secret:NAME}} occurrences in `text` via `vault`. Throws
 * MissingSecretError when a referenced secret is missing (no vault at all, or
 * the vault doesn't hold NAME). Returns `text` unchanged when it has no
 * placeholders — the common case, and the only one that doesn't need a vault. */
function resolveReplaySecrets(text: string, vault: ReplaySecretsSource | undefined): string {
  text = resolveTotpPlaceholders(text, vault);
  if (!SECRET_PLACEHOLDER_RE.test(text)) return text;
  SECRET_PLACEHOLDER_RE.lastIndex = 0;
  return text.replace(SECRET_PLACEHOLDER_RE, (_m, name: string) => {
    const value = vault?.get(name);
    if (value === undefined) throw new MissingSecretError(name);
    return value;
  });
}

/** A12 (P0): true when `report` is a replay failure caused by an unresolved
 * `{{secret:NAME}}` — either a `type` step (MissingSecretError above) or a
 * `script` step's nested executor (driver/script-runner/executor.ts, same
 * "spike secret set" remediation text). Pure string check on the failing
 * step's recorded error: that's the only place the distinction survives,
 * since replayScript folds every step failure into the same Report shape.
 * Exported so engine.ts's replay-fallback decision doesn't have to guess at
 * the message format independently. */
export function isMissingSecretFailure(report: Report): boolean {
  if (report.verdict !== 'fail' || !report.failing_step) return false;
  const step = report.steps[report.failing_step.index];
  return typeof step?.error === 'string' && step.error.includes('spike secret set');
}

/** A1 (P0): script step types that change the page. A saved test is a sequence
 * of these by construction, so look-only mode can't "partially" run one — see
 * replayScript's up-front refusal. Mirrors driver/loop.ts's mutation set. */
const MUTATING_SCRIPT_STEPS = new Set<ScriptStep['type']>([
  'click', 'type', 'press_key', 'select_option', 'upload_file', 'drag_and_drop', 'mouse', 'script',
]);

export interface ReplayOptions {
  onProgress?: (line: string) => void;
  /** A1 (P0): look-only mode (`spike replay --read-only`). A saved test is made
   * of clicks and typing, so there is nothing honest to run: rather than skip
   * every step and report a meaningless pass, the replay refuses up front with
   * a plain-English `uncertain`. Absent/false → today's behaviour exactly. */
  readOnly?: boolean;
  /** Secrets store for a recorded `type` step's {{secret:NAME}} placeholders
   * (and a `script` step's, via driver/script-runner/executor.ts). Optional —
   * without it, a step referencing a secret fails loudly with
   * MissingSecretError rather than typing the literal placeholder text. */
  vault?: ReplaySecretsSource;
}

export async function replayScript(
  browser: BrowserPort,
  nano: NanoPort | null,
  artifacts: ArtifactStore,
  script: QaScript,
  opts: ReplayOptions = {},
): Promise<Report> {
  const t0 = Date.now();
  const progress = opts.onProgress ?? (() => {});
  const steps: StepRecord[] = [];
  let verdict: RunVerdict = 'pass';
  let reason = `replayed ${script.steps.length} recorded steps without drift`;
  let failingStep: FailingStep | null = null;
  let visualsSkipped = 0;
  let extractsSkipped = 0;
  const runData = createRunDataState();
  // Runtime ids returned by browser.openTab() during THIS replay, in the order
  // open_tab steps ran — resolves a recorded switch_tab/close_tab tabIndex
  // (0 = the original tab; N = the Nth open_tab call) to a real id/index.
  const openedTabIds: string[] = [];

  // A1 (P0): look-only mode — refuse before touching the page, with a reason
  // that says what to do about it, instead of half-running the saved test.
  if (opts.readOnly && script.steps.some((s) => MUTATING_SCRIPT_STEPS.has(s.type))) {
    const refusal: Report = {
      verdict: 'uncertain',
      failing_step: null,
      console_error: null,
      evidence_paths: [],
      reason:
        `look-only mode is on, so this saved test can\u2019t run \u2014 "${script.name}" clicks and types on the page. ` +
        'Run it again without look-only mode.',
      runId: artifacts.runId,
      task: `[replay:${script.name}] ${script.task}`,
      url: script.url,
      steps: [],
      model_trace: [],
      run_data: runData,
      durationMs: Date.now() - t0,
      tokenEstimate: 0,
    };
    progress(refusal.reason);
    const refusalPath = await artifacts.saveReport(refusal);
    refusal.evidence_paths.unshift(refusalPath);
    await artifacts.saveReport(refusal);
    return refusal;
  }

  const nanoReady = nano !== null && (await nano.availability().catch(() => 'unavailable')) === 'available';
  if (nano && !nanoReady) progress('warning: Gemini Nano unavailable — visual assertions will be SKIPPED (replays never spend paid tokens)');
  if (nanoReady) await nano!.warmup();

  await browser.navigate(script.url);
  browser.drainConsole();
  browser.drainNetwork();

  for (let i = 0; i < script.steps.length; i++) {
    const s = script.steps[i];
    const record: StepRecord = {
      index: i,
      action: toAction(s),
      description: describeScriptStep(s),
      ok: true,
      console: [],
      network: [],
      ts: Date.now(),
    };
    if ('target' in s) record.target = s.target;
    steps.push(record);
    progress(`step ${i + 1}/${script.steps.length}: ${record.description}`);

    try {
      switch (s.type) {
        case 'navigate':
          await browser.navigate(s.url);
          break;
        case 'click': {
          const node = await findByTarget(browser, s.target);
          // A4 (P0): Playwright-style actionability before acting — findByTarget
          // only proved the role+name resolves in the AX tree, not that the
          // node is visible/enabled/settled yet (a fade-in, a disabled-until-
          // validated submit button). Guarded: optional on BrowserPort.
          await browser.waitForActionable?.(node.id);
          await browser.click(node.id);
          break;
        }
        case 'type': {
          const node = await findByTarget(browser, s.target);
          await browser.waitForActionable?.(node.id);
          // A12 (P0): {{run.*}} first, then {{secret:NAME}} — the record keeps
          // the ORIGINAL placeholder text (record.target/description above are
          // built from `s`, not the resolved value), so the real secret never
          // lands in a report/log.
          const resolvedRun = resolveRunPlaceholders(s.text, runData).text;
          const resolved = resolveReplaySecrets(resolvedRun, opts.vault);
          await browser.type(node.id, resolved);
          break;
        }
        case 'hover': {
          const node = await findByTarget(browser, s.target);
          await browser.waitForActionable?.(node.id);
          await browser.hover(node.id);
          break;
        }
        case 'press_key':
          await browser.pressKey(s.key);
          break;
        case 'select_option': {
          const node = await findByTarget(browser, s.target);
          await browser.waitForActionable?.(node.id);
          await browser.selectOption(node.id, s.value);
          break;
        }
        case 'reload':
          await browser.reload();
          break;
        case 'go_back':
          await browser.goBack();
          break;
        case 'assert_dom': {
          const node = await findByTarget(browser, s.target);
          const ax = await browser.axTree();
          const fresh = findNodeById(ax.root, node.id) ?? node;
          const hay = subtreeText(fresh).toLowerCase();
          if (!hay.includes(s.contains.toLowerCase())) {
            throw new Error(`expected ${JSON.stringify(s.contains)} in ${s.target.role} "${s.target.name ?? ''}", found: ${hay.slice(0, 150)}`);
          }
          break;
        }
        case 'extract': {
          if (s.prompt) {
            // model-assisted extraction spends a paid model call — replay
            // stays $0/zero-planner-calls, so this is SKIPPED with a warning,
            // same convention as an unavailable-Nano visual assertion. A later
            // {{run.key}} reference will fail with a precise "not found" error.
            extractsSkipped++;
            record.description += ' [SKIPPED: model-assisted extraction spends a model call — replay stays $0]';
            break;
          }
          if (!s.target) throw new Error(`extract ${s.key} has neither a target nor a prompt`);
          const node = await findByTarget(browser, s.target);
          const ax = await browser.axTree();
          const fresh = findNodeById(ax.root, node.id) ?? node;
          const value = extractValue(subtreeText(fresh).trim(), s.pattern);
          if (!value) throw new Error(`could not extract ${s.key} from ${s.target.role} "${s.target.name ?? ''}"`);
          recordExtraction(runData, { key: s.key, value, source: 'dom', label: s.target.name });
          break;
        }
        case 'upload_file': {
          const node = await findByTarget(browser, s.target);
          await browser.waitForActionable?.(node.id);
          await browser.uploadFile(node.id, s.paths);
          break;
        }
        case 'drag_and_drop': {
          const source = await findByTarget(browser, s.source);
          if (!s.target) throw new Error(`drag_and_drop ${s.source.role} "${s.source.name ?? ''}" has no recorded drop target`);
          const target = await findByTarget(browser, s.target);
          await browser.waitForActionable?.(source.id);
          await browser.waitForActionable?.(target.id);
          await browser.dragAndDrop(source.id, target.id);
          break;
        }
        case 'blur': {
          const node = await findByTarget(browser, s.target);
          await browser.waitForActionable?.(node.id);
          await browser.blur(node.id);
          break;
        }
        case 'mouse':
          await browser.mouse(s.kind, s.x, s.y);
          break;
        case 'open_tab': {
          const tabId = await browser.openTab(s.url);
          openedTabIds.push(tabId);
          break;
        }
        case 'switch_tab':
          await browser.switchTab(s.tabIndex);
          break;
        case 'close_tab': {
          if (s.tabIndex === 0) {
            throw new Error('close_tab #0 (the original tab) cannot be replayed — it was recorded while the script was on a different tab');
          }
          const tabId = openedTabIds[s.tabIndex - 1];
          if (!tabId) throw new Error(`close_tab #${s.tabIndex} has no matching open_tab earlier in this replay`);
          await browser.closeTab(tabId);
          break;
        }
        case 'script': {
          // RE-VALIDATE on every replay — never trust a persisted script step
          // just because it passed validation when it was recorded.
          const validated = validateScriptSteps(s.steps);
          if (!validated.ok) throw new Error(`recorded script step failed re-validation: ${validated.reason}`);
          const result = await runScriptSteps(browser, validated.steps, runData, opts.vault);
          if (!result.ok) throw new Error(`script failed after ${result.executedSteps} step(s): ${result.error}`);
          break;
        }
        case 'assert_visual': {
          if (!nanoReady) {
            visualsSkipped++;
            record.description += ' [SKIPPED: Nano unavailable]';
            break;
          }
          const png = await browser.screenshot();
          record.screenshot = await artifacts.saveScreenshot(i, png);
          const { verdict: v } = await nano!.verdict(png, s.expectation);
          record.visual = v;
          if (v.verdict === 'fail') {
            throw new Error(`visual assertion failed: ${v.summary}${v.issues.length ? ` — ${v.issues.join('; ')}` : ''}`);
          }
          break;
        }
        case 'wait':
          await sleep(s.ms);
          break;
      }
    } catch (e) {
      record.ok = false;
      record.error = e instanceof Error ? e.message : String(e);
      verdict = 'fail';
      reason = `replay failed at step ${i + 1} (${record.description}): ${record.error}`;
      failingStep = { index: i, action: record.action, description: record.description };
    }

    // A4 (P0): waitForIdle() now exists (browser-port.ts) — a real
    // network-quiet condition replaces the flat sleep(250) this used to be.
    // Ports that don't implement it (the optional method is guarded) fall
    // back to the old fixed sleep so nothing regresses on a partial
    // transport. Runs BEFORE the drain below either way, same ordering as
    // before.
    if (browser.waitForIdle) {
      await browser.waitForIdle();
    } else {
      await sleep(250);
    }
    record.console = browser.drainConsole();
    record.network = browser.drainNetwork();

    // strictness: runtime errors during a replayed step are a regression even
    // if the step itself "worked"
    if (verdict === 'pass') {
      const err = firstError(record.console, record.network);
      if (err) {
        verdict = 'fail';
        reason = `replay step ${i + 1} caused a runtime error: ${err}`;
        failingStep = { index: i, action: record.action, description: record.description };
        record.ok = false;
        record.error = err;
      }
    }
    if (verdict === 'fail') break;
  }

  if (verdict === 'pass' && visualsSkipped > 0) {
    reason += ` (${visualsSkipped} visual assertion(s) skipped — Nano unavailable)`;
  }
  if (verdict === 'pass' && extractsSkipped > 0) {
    reason += ` (${extractsSkipped} model-assisted extraction(s) skipped — replay stays $0)`;
  }

  // final screenshot as evidence either way
  const last = steps[steps.length - 1];
  if (last && !last.screenshot) {
    try {
      last.screenshot = await artifacts.saveScreenshot(last.index, await browser.screenshot());
    } catch {
      /* page may be gone */
    }
  }

  let consoleError: string | null = null;
  for (const s of [...steps].reverse()) {
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
    evidence_paths: steps.filter((s) => s.screenshot).map((s) => s.screenshot!),
    reason,
    runId: artifacts.runId,
    task: `[replay:${script.name}] ${script.task}`,
    url: script.url,
    steps,
    model_trace: [], // the whole point: no planner in the trace
    run_data: runData,
    durationMs: Date.now() - t0,
    tokenEstimate: 0,
  };
  const reportPath = await artifacts.saveReport(report);
  report.evidence_paths.unshift(reportPath);
  await artifacts.saveReport(report);
  return report;
}

/* ---------- helpers ---------- */

function toAction(s: ScriptStep): StepRecord['action'] {
  switch (s.type) {
    case 'navigate':
      return { type: 'navigate', url: s.url };
    case 'click':
      return { type: 'click', nodeId: `<${s.target.role}:${s.target.name ?? ''}>` };
    case 'type':
      return { type: 'type', nodeId: `<${s.target.role}:${s.target.name ?? ''}>`, text: s.text };
    case 'hover':
      return { type: 'hover', nodeId: `<${s.target.role}:${s.target.name ?? ''}>` };
    case 'press_key':
      return { type: 'press_key', key: s.key };
    case 'select_option':
      return { type: 'select_option', nodeId: `<${s.target.role}:${s.target.name ?? ''}>`, value: s.value };
    case 'reload':
      return { type: 'reload' };
    case 'go_back':
      return { type: 'go_back' };
    case 'assert_dom':
      return { type: 'assert_dom', nodeId: `<${s.target.role}:${s.target.name ?? ''}>`, contains: s.contains };
    case 'extract':
      return {
        type: 'extract',
        ...(s.target && { nodeId: `<${s.target.role}:${s.target.name ?? ''}>` }),
        key: s.key,
        ...(s.pattern && { pattern: s.pattern }),
        ...(s.prompt && { prompt: s.prompt }),
      };
    case 'assert_visual':
      return { type: 'assert_visual', expectation: s.expectation, ...(s.mode && { mode: s.mode }) };
    case 'wait':
      return { type: 'wait', ms: s.ms };
    case 'upload_file':
      return { type: 'upload_file', nodeId: `<${s.target.role}:${s.target.name ?? ''}>`, paths: s.paths };
    case 'drag_and_drop':
      return {
        type: 'drag_and_drop',
        sourceId: `<${s.source.role}:${s.source.name ?? ''}>`,
        targetId: s.target ? `<${s.target.role}:${s.target.name ?? ''}>` : '<unresolved>',
      };
    case 'blur':
      return { type: 'blur', nodeId: `<${s.target.role}:${s.target.name ?? ''}>` };
    case 'mouse':
      return { type: 'mouse', kind: s.kind, x: s.x, y: s.y };
    case 'open_tab':
      return { type: 'open_tab', url: s.url };
    case 'switch_tab':
      return { type: 'switch_tab', tabId: `#${s.tabIndex}` };
    case 'close_tab':
      return { type: 'close_tab', tabId: `#${s.tabIndex}` };
    case 'script':
      return { type: 'script', steps: s.steps };
  }
}

function describeScriptStep(s: ScriptStep): string {
  switch (s.type) {
    case 'navigate':
      return `navigate to ${s.url}`;
    case 'click':
      return `click ${s.target.role} "${s.target.name ?? ''}"`;
    case 'type':
      return `type ${JSON.stringify(s.text)} into ${s.target.role} "${s.target.name ?? ''}"`;
    case 'hover':
      return `hover ${s.target.role} "${s.target.name ?? ''}"`;
    case 'press_key':
      return `press key ${s.key}`;
    case 'select_option':
      return `select ${JSON.stringify(s.value)} in ${s.target.role} "${s.target.name ?? ''}"`;
    case 'reload':
      return 'reload page';
    case 'go_back':
      return 'go back';
    case 'assert_dom':
      return `dom check: ${s.target.role} "${s.target.name ?? ''}" contains ${JSON.stringify(s.contains)}`;
    case 'extract':
      return s.prompt
        ? `extract ${s.key} (model-assisted)`
        : `extract ${s.key} from ${s.target ? `${s.target.role} "${s.target.name ?? ''}"` : 'page'}`;
    case 'assert_visual':
      return `${s.mode === 'video' ? 'video' : 'visual'} check: ${s.expectation.slice(0, 80)}`;
    case 'wait':
      return `wait ${s.ms}ms`;
    case 'upload_file':
      return `upload ${s.paths.length} file(s) to ${s.target.role} "${s.target.name ?? ''}"`;
    case 'drag_and_drop':
      return `drag ${s.source.role} "${s.source.name ?? ''}" to ${s.target ? `${s.target.role} "${s.target.name ?? ''}"` : '(unresolved)'}`;
    case 'blur':
      return `blur ${s.target.role} "${s.target.name ?? ''}"`;
    case 'mouse':
      return `mouse ${s.kind} (${s.x}, ${s.y})`;
    case 'open_tab':
      return `open tab ${s.url}`;
    case 'switch_tab':
      return `switch to tab #${s.tabIndex}`;
    case 'close_tab':
      return `close tab #${s.tabIndex}`;
    case 'script':
      return `run script (${s.steps.length} step(s))`;
  }
}

/* ---------- A8 (P1): candidate-locator stack resolution ---------- */

/** Outcome of trying to resolve a `ScriptTarget` against ONE in-memory
 * `AxSnapshot` — pure, no browser/CDP calls (the `qaId`/`testId` LIVE
 * fallbacks are async and handled one layer up, in `findByTarget`, since they
 * need a real DOM query). Exported for direct unit testing (test/v50). */
export type TargetResolution =
  | { status: 'found'; node: AxNode; via: LocatorCandidate['kind'] }
  | { status: 'absent' }
  /** Present, but role+name alone didn't uniquely pick one and no candidate
   * further down the in-tree stack (testid/text) resolved it either — the
   * live wrapper still gets one more shot via the qaId/testId LIVE fallbacks
   * before this becomes the thrown error. */
  | { status: 'ambiguous'; detail: string };

/** A role+name match plus enough tree context (ancestor chain, sibling list)
 * to SCORE it against a target's disambiguation hints. */
interface RoleMatch {
  node: AxNode;
  /** 0-based index among role+name matches, in document (pre-order) order —
   * what a recorded `nth` refers to. */
  index: number;
  /** Root → immediate-parent ancestor chain (excludes the node itself). */
  ancestors: AxNode[];
  /** The node's own sibling list (its parent's children), INCLUDING itself. */
  siblings: AxNode[];
}

/** Roles treated as "landmarks" for the nearest-landmark disambiguation hint
 * — a superset small enough to stay a clear structural signal (a table row, a
 * dialog, a nav region…), not every STRUCTURAL role in axtree.ts. */
const LANDMARK_ROLES = new Set([
  'navigation', 'main', 'form', 'dialog', 'alertdialog', 'table', 'row',
  'list', 'region', 'banner', 'contentinfo', 'complementary', 'article',
]);

/** All nodes matching role+name, in document (pre-order) order, each with its
 * ancestor chain and sibling list for scoring. */
function collectRoleMatches(root: AxNode, role: string, name?: string): RoleMatch[] {
  const out: RoleMatch[] = [];
  let index = 0;
  const walk = (n: AxNode, ancestors: AxNode[], siblings: AxNode[]): void => {
    if (n.role === role && n.name === name) out.push({ node: n, index: index++, ancestors, siblings });
    const children = n.children ?? [];
    for (const c of children) walk(c, [...ancestors, n], children);
  };
  walk(root, [], [root]);
  return out;
}

/** Nodes whose accessible name exactly matches `text` (case/whitespace
 * insensitive) — the last-resort locator for elements with no stable role or
 * testid (a canvas/SVG label, an ad-hoc `<div>`). */
function collectByText(root: AxNode, text: string): AxNode[] {
  const needle = text.trim().toLowerCase();
  const out: AxNode[] = [];
  const walk = (n: AxNode): void => {
    if (n.name && n.name.trim().toLowerCase() === needle) out.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return out;
}

/** Nodes stamped with a matching `AxNode.testId` (see browser-port.ts) — the
 * common, zero-round-trip path; the live `findByTestId` port method is the
 * fallback for when the snapshot predates the element. */
function collectByTestId(root: AxNode, testId: string): AxNode[] {
  const out: AxNode[] = [];
  const walk = (n: AxNode): void => {
    if (n.testId === testId) out.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return out;
}

const nearestLandmark = (ancestors: AxNode[]): AxNode | undefined => {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (LANDMARK_ROLES.has(ancestors[i].role)) return ancestors[i];
  }
  return undefined;
};

/** Score ONE role+name match against a target's disambiguation hints. Purely
 * additive signals — each on its own is worth enough to break a tie against a
 * candidate with none of it, but a genuine tie (same score, e.g. no hints on
 * either side) MUST stay a tie; see `pickClearRoleWinner`. */
function scoreRoleMatch(m: RoleMatch, c: Extract<LocatorCandidate, { kind: 'role' }>): number {
  let score = 0;
  // Position closeness to a recorded nth — the virtualised-list case: the
  // page still has the item, just at a shifted index (scroll, pagination).
  if (typeof c.nth === 'number') score += Math.max(0, 10 - Math.abs(m.index - c.nth));
  // Nearest-landmark match — the data-table-row case: two "Delete" buttons
  // that live under two different rows/regions.
  if (c.landmark) {
    const lm = nearestLandmark(m.ancestors);
    if (lm && lm.role === c.landmark.role && (c.landmark.name === undefined || lm.name === c.landmark.name)) {
      score += 20;
    }
  }
  // Sibling text — the recorded target sat next to text that uniquely
  // identifies its row/group even when the control itself doesn't.
  if (c.siblingText) {
    const needle = c.siblingText.toLowerCase();
    if (m.siblings.some((s) => s !== m.node && s.name?.toLowerCase().includes(needle))) score += 15;
  }
  return score;
}

/** Pick a role+name match ONLY when it is a CLEAR winner: at least one
 * disambiguation signal fired (score > 0) AND no other candidate tied it.
 * Two equally-good candidates — including the common case of NO signal at
 * all, where every match scores 0 — return null, preserving today's explicit
 * failure rather than silently guessing (per the A8 finding: "a wrong click
 * is worse than a clear error"). */
function pickClearRoleWinner(matches: RoleMatch[], c: Extract<LocatorCandidate, { kind: 'role' }>): AxNode | null {
  const scored = matches.map((m) => ({ m, score: scoreRoleMatch(m, c) })).sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score <= 0) return null;
  const second = scored[1];
  if (second && second.score >= best.score) return null; // tie at the top — no clear winner
  return best.m.node;
}

/** Resolve a `ScriptTarget` against ONE already-fetched `AxSnapshot`, trying
 * its candidate stack (`candidateStackFor` — testid → role+name(+nth,
 * scored) → text) in order and degrading to the next instead of failing
 * outright. `qaId` candidates are skipped here (they need a live DOM query —
 * see `findByTarget`'s async wrapper) but still recorded into the returned
 * `ambiguous` detail's precedence: role ambiguity is remembered and only
 * surfaced if nothing later in the stack (including the live qaId/testid
 * fallbacks one layer up) resolves it either — exactly mirroring the
 * pre-A8 order (role+name, then qaId, then fail). */
export function resolveTargetInTree(root: AxNode, target: ScriptTarget): TargetResolution {
  let ambiguousDetail: string | undefined;
  for (const c of candidateStackFor(target)) {
    if (c.kind === 'qaId') continue; // live-DOM only; handled by the async wrapper
    if (c.kind === 'testid') {
      const matches = collectByTestId(root, c.value);
      if (matches.length > 0) return { status: 'found', node: matches[0], via: 'testid' };
      continue;
    }
    if (c.kind === 'text') {
      const matches = collectByText(root, c.value);
      if (matches.length === 1) return { status: 'found', node: matches[0], via: 'text' };
      continue; // zero or ambiguous by text — nothing further to degrade to
    }
    // c.kind === 'role'
    const matches = collectRoleMatches(root, c.role, c.name);
    if (matches.length === 0) continue;
    if (typeof c.nth === 'number') {
      if (c.nth >= 0 && c.nth < matches.length) return { status: 'found', node: matches[c.nth].node, via: 'role' };
      const winner = pickClearRoleWinner(matches, c);
      if (winner) return { status: 'found', node: winner, via: 'role' };
      ambiguousDetail ??= `locator out of range: nth=${c.nth} but only ${matches.length} × ${c.role} "${c.name ?? ''}" on the page`;
      continue;
    }
    if (matches.length === 1) return { status: 'found', node: matches[0].node, via: 'role' };
    const winner = pickClearRoleWinner(matches, c);
    if (winner) return { status: 'found', node: winner, via: 'role' };
    ambiguousDetail ??= `ambiguous locator: ${matches.length} × ${c.role} "${c.name ?? ''}" — re-record or refine (add nth)`;
  }
  if (ambiguousDetail) return { status: 'ambiguous', detail: ambiguousDetail };
  return { status: 'absent' };
}

/** Find the node a target locator points at, polling while the page settles.
 *
 * A8 (P1) resolution order (see `resolveTargetInTree`/`candidateStackFor`):
 * testid → role+name(+nth, scored on ambiguity/out-of-range) → stamped qaId
 * (live) → text → testid (live, in case the snapshot predates the element).
 * A legacy target (no `candidates`) synthesizes exactly `[role+name+nth,
 * qaId?]` — the pre-A8 stack — so it degrades through the identical two steps
 * in the identical order it always has; the only behaviour change for such a
 * target is that a role+name ambiguity/out-of-range case gets ONE extra,
 * purely-additive chance (scored disambiguation) before falling through to
 * qaId exactly as before. Timing is preserved too: an "absent" result keeps
 * polling until the timeout (unresolved matches might still be rendering); an
 * "ambiguous" result (the element(s) DO exist, just not uniquely) fails
 * immediately after one qaId/testid attempt, same as pre-A8 — polling cannot
 * fix an ambiguity that already exists. */
async function findByTarget(browser: BrowserPort, target: ScriptTarget): Promise<AxNode> {
  const deadline = Date.now() + FIND_TIMEOUT_MS;
  for (;;) {
    const ax = await browser.axTree();
    const resolution = resolveTargetInTree(ax.root, target);
    if (resolution.status === 'found') return resolution.node;
    if (resolution.status === 'ambiguous') {
      const viaQa = await tryQaIdFallback(browser, target);
      if (viaQa) return viaQa;
      const viaTestId = await tryTestIdFallback(browser, target);
      if (viaTestId) return viaTestId;
      throw new Error(resolution.detail);
    }
    if (Date.now() > deadline) {
      // zero matches anywhere in the stack (UI drift) — last resort: the live
      // qaId/testid lookups.
      const viaQa = await tryQaIdFallback(browser, target);
      if (viaQa) return viaQa;
      const viaTestId = await tryTestIdFallback(browser, target);
      if (viaTestId) return viaTestId;
      throw new Error(`UI drift: no ${target.role} ${target.name ? `"${target.name}" ` : ''}on the page after ${FIND_TIMEOUT_MS}ms`);
    }
    await sleep(300);
  }
}

/** #9 fallback: when role+name resolution fails or is ambiguous, locate by the
 * stamped `data-qa-id` (best-effort — the attribute is lost across reloads, so a
 * miss returns null and the caller keeps its precise role+name error). Returns a
 * minimal AxNode whose `id` is a port nodeId usable by click()/type(). */
async function tryQaIdFallback(browser: BrowserPort, target: ScriptTarget): Promise<AxNode | null> {
  if (!target.qaId || !browser.findByQaId) return null;
  const nodeId = await browser.findByQaId(target.qaId).catch(() => null);
  if (!nodeId) return null;
  return { id: nodeId, role: target.role, name: target.name };
}

/** A8 (P1) live fallback: only tried when the target's candidate stack
 * actually carries a testid candidate (mirrors `tryQaIdFallback`'s own
 * guard) — locates by `data-testid`/alias directly in the live DOM for the
 * uncommon case where the already-fetched snapshot predates the element. */
async function tryTestIdFallback(browser: BrowserPort, target: ScriptTarget): Promise<AxNode | null> {
  const testIdCandidate = candidateStackFor(target).find((c): c is Extract<LocatorCandidate, { kind: 'testid' }> => c.kind === 'testid');
  if (!testIdCandidate || !browser.findByTestId) return null;
  const nodeId = await browser.findByTestId(testIdCandidate.value).catch(() => null);
  if (!nodeId) return null;
  return { id: nodeId, role: target.role, name: target.name };
}

function findNodeById(root: AxNode, id: string): AxNode | undefined {
  if (root.id === id) return root;
  for (const c of root.children ?? []) {
    const hit = findNodeById(c, id);
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
