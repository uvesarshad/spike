/* Secure script runner — executor. Runs an ALREADY-VALIDATED step list
 * (see validator.ts — never call this on unvalidated input) against
 * BrowserPort only. {{run.*}} and {{secret:NAME}} placeholders resolve at
 * execute time, exactly like the main driver loop's `type` action — the
 * resolved value is never returned to the caller, so it never lands in a
 * report/record. Steps run sequentially under a wall-time budget. */

import type { AxNode, BrowserPort } from '../../ports/browser-port.js';
import type { Vault } from '../../vault/vault.js';
import { recordExtraction, resolveRunPlaceholders, type RunDataState } from '../../run-data/index.js';
import { SCRIPT_MAX_WALL_MS, type ScriptRunnerStep } from './schema.js';

const SECRET_RE = /\{\{secret:([a-zA-Z0-9_-]+)\}\}/g;

/** Mirrors loop.ts's resolveSecrets: {{secret:NAME}} resolved AT EXECUTE TIME
 * ONLY. Throws when the vault doesn't hold the named secret. */
function resolveSecrets(text: string, vault: Vault | undefined): string {
  if (!SECRET_RE.test(text)) return text;
  SECRET_RE.lastIndex = 0;
  return text.replace(SECRET_RE, (_m, name: string) => {
    const value = vault?.get(name);
    if (value === undefined) {
      throw new Error(`secret "${name}" not found — add it with: qa secret set ${name}`);
    }
    return value;
  });
}

export interface ScriptExecutionResult {
  ok: boolean;
  executedSteps: number;
  error?: string;
}

export interface ScriptExecutionOptions {
  /** Wall-time budget for the WHOLE step list, in ms. Defaults to SCRIPT_MAX_WALL_MS. */
  maxWallMs?: number;
}

/** Execute a validated script step-by-step. Stops (and reports which step)
 * on the first failure — a script action is all-or-nothing, same as any
 * other single driver action. Never throws: failures come back as
 * `{ ok: false, error }` so the loop can fold them into a normal step record. */
export async function runScriptSteps(
  browser: BrowserPort,
  steps: ScriptRunnerStep[],
  runData: RunDataState,
  vault: Vault | undefined,
  opts: ScriptExecutionOptions = {},
): Promise<ScriptExecutionResult> {
  const maxWallMs = opts.maxWallMs ?? SCRIPT_MAX_WALL_MS;
  const deadline = Date.now() + maxWallMs;
  let executedSteps = 0;
  for (const step of steps) {
    if (Date.now() > deadline) {
      return { ok: false, executedSteps, error: `script exceeded its ${maxWallMs}ms wall-time budget after ${executedSteps} step(s)` };
    }
    try {
      await runOneStep(browser, step, runData, vault);
    } catch (e) {
      return { ok: false, executedSteps, error: `step ${executedSteps} (${step.type}): ${e instanceof Error ? e.message : String(e)}` };
    }
    executedSteps++;
  }
  return { ok: true, executedSteps };
}

async function runOneStep(browser: BrowserPort, step: ScriptRunnerStep, runData: RunDataState, vault: Vault | undefined): Promise<void> {
  switch (step.type) {
    case 'navigate':
      return browser.navigate(step.url);
    case 'click':
      return browser.click(step.nodeId);
    case 'type': {
      const resolvedRun = resolveRunPlaceholders(step.text, runData).text;
      const resolved = resolveSecrets(resolvedRun, vault);
      return browser.type(step.nodeId, resolved);
    }
    case 'hover':
      return browser.hover(step.nodeId);
    case 'press_key':
      return browser.pressKey(step.key);
    case 'select_option':
      return browser.selectOption(step.nodeId, step.value);
    case 'reload':
      return browser.reload();
    case 'go_back':
      return browser.goBack();
    case 'wait':
      return new Promise((resolve) => setTimeout(resolve, step.ms));
    case 'assert_dom': {
      const ax = await browser.axTree();
      const node = findNode(ax.root, step.nodeId);
      const hay = node ? subtreeText(node) : '';
      if (!hay.toLowerCase().includes(step.contains.toLowerCase())) {
        throw new Error(`expected ${JSON.stringify(step.contains)} in ${step.nodeId}, found: ${hay.slice(0, 150)}`);
      }
      return;
    }
    case 'extract': {
      const ax = await browser.axTree();
      const node = findNode(ax.root, step.nodeId);
      if (!node) throw new Error(`nodeId ${step.nodeId} not in current tree`);
      const value = extractValue(subtreeText(node).trim(), step.pattern);
      if (!value) throw new Error(`could not extract ${step.key} from ${step.nodeId}`);
      recordExtraction(runData, { key: step.key, value, source: 'dom', label: node.name });
      return;
    }
    case 'upload_file':
      return browser.uploadFile(step.nodeId, step.paths);
    case 'drag_and_drop':
      return browser.dragAndDrop(step.sourceId, step.targetId);
    case 'blur':
      return browser.blur(step.nodeId);
    case 'mouse':
      return browser.mouse(step.kind, step.x, step.y);
  }
}

function findNode(root: AxNode, id: string): AxNode | undefined {
  if (root.id === id) return root;
  for (const c of root.children ?? []) {
    const hit = findNode(c, id);
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
