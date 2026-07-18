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
import type { QaScript, ScriptStep, ScriptTarget } from './script.js';
import { createRunDataState, recordExtraction, resolveRunPlaceholders } from '../run-data/index.js';
import { validateScriptSteps, runScriptSteps } from '../driver/script-runner/index.js';
import type { Vault } from '../vault/vault.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const FIND_TIMEOUT_MS = 5_000;

export interface ReplayOptions {
  onProgress?: (line: string) => void;
  /** Secrets store for a recorded `script` step's {{secret:NAME}} placeholders
   * (and, for parity, a `type` step's). Optional — without it a step
   * referencing a secret fails exactly as it would live. */
  vault?: Vault;
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
          await browser.click(node.id);
          break;
        }
        case 'type': {
          const node = await findByTarget(browser, s.target);
          await browser.type(node.id, resolveRunPlaceholders(s.text, runData).text);
          break;
        }
        case 'hover': {
          const node = await findByTarget(browser, s.target);
          await browser.hover(node.id);
          break;
        }
        case 'press_key':
          await browser.pressKey(s.key);
          break;
        case 'select_option': {
          const node = await findByTarget(browser, s.target);
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
          await browser.uploadFile(node.id, s.paths);
          break;
        }
        case 'drag_and_drop': {
          const source = await findByTarget(browser, s.source);
          if (!s.target) throw new Error(`drag_and_drop ${s.source.role} "${s.source.name ?? ''}" has no recorded drop target`);
          const target = await findByTarget(browser, s.target);
          await browser.dragAndDrop(source.id, target.id);
          break;
        }
        case 'blur': {
          const node = await findByTarget(browser, s.target);
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

    // A13 (P1, best-effort — skipped): see loop.ts's identical note — BrowserPort
    // has no non-destructive in-flight/idle check to poll here without extending
    // the port interface, which is out of scope for this pass.
    await sleep(250);
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

/** Find the node a target locator points at, polling while the page settles.
 *
 * Disambiguation semantics:
 *   - `nth` set → use the nth (0-based) role+name match; out-of-range fails.
 *   - `nth` unset + exactly one match → use it.
 *   - `nth` unset + MULTIPLE matches → FAIL with a precise 'ambiguous locator'
 *     error rather than silently picking the first. (COMPROMISE for this round:
 *     the loop doesn't yet record which of N matches it used, so a recorded
 *     script can't carry `nth` automatically — but the replay schema accepts it,
 *     so a future loop change can populate `nth` with no version bump, and
 *     hand-authored scripts can use it today.)
 *   - zero matches → UI-drift error after the settle timeout. */
async function findByTarget(browser: BrowserPort, target: ScriptTarget): Promise<AxNode> {
  const { role, name, nth } = target;
  const deadline = Date.now() + FIND_TIMEOUT_MS;
  for (;;) {
    const ax = await browser.axTree();
    const matches = collectByRoleName(ax.root, role, name);
    if (matches.length > 0) {
      if (typeof nth === 'number') {
        if (nth < 0 || nth >= matches.length) {
          // nth out of range can be UI drift (fewer matches than recorded) —
          // try the qaId fallback before failing.
          const viaQa = await tryQaIdFallback(browser, target);
          if (viaQa) return viaQa;
          throw new Error(
            `locator out of range: nth=${nth} but only ${matches.length} × ${role} "${name ?? ''}" on the page`,
          );
        }
        return matches[nth];
      }
      if (matches.length === 1) return matches[0];
      // ambiguous role+name — a stamped data-qa-id (#9) resolves it uniquely.
      const viaQa = await tryQaIdFallback(browser, target);
      if (viaQa) return viaQa;
      throw new Error(
        `ambiguous locator: ${matches.length} × ${role} "${name ?? ''}" — re-record or refine (add nth)`,
      );
    }
    if (Date.now() > deadline) {
      // zero role+name matches (UI drift) — last resort: the stamped data-qa-id.
      const viaQa = await tryQaIdFallback(browser, target);
      if (viaQa) return viaQa;
      throw new Error(`UI drift: no ${role} ${name ? `"${name}" ` : ''}on the page after ${FIND_TIMEOUT_MS}ms`);
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

/** All nodes matching role+name, in document (pre-order) order. */
function collectByRoleName(root: AxNode, role: string, name?: string): AxNode[] {
  const out: AxNode[] = [];
  const walk = (n: AxNode): void => {
    if (n.role === role && n.name === name) out.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return out;
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
