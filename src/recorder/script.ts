/* Recorded QA scripts — "AI once → deterministic forever".
 *
 * A passed run is distilled into a JSON script of resilient steps (role+name
 * locators, never nodeIds). `spike replay` executes that JSON over CDP with zero
 * planner calls — the JSON is the one and only EXECUTABLE artifact. A
 * Playwright-flavoured `.spec.ts` twin is emitted alongside it as a
 * human-readable TRANSLATION of the same steps (A16): useful for review/diff
 * and as a sketch of what a hand-ported Playwright test would look like, but
 * not itself runnable as shipped — there is no `@playwright/test` dependency
 * or config here, and `spike` never executes it. See the header codegen'd
 * into every emitted file for exactly what's missing to make it real. */

import fs from 'node:fs';
import path from 'node:path';
import type { Report, StepRecord, StepTarget } from '../report/report.js';
import type { ScriptRunnerStep } from '../driver/script-runner/schema.js';
import { validateQaScript } from './schema.js';

/** A script-step locator: role+name plus optional `nth` / `qaId` disambiguators.
 *
 * `nth` (0-based) picks which of several role+name matches to act on when a page
 * has duplicates (two "Edit" buttons, three "Delete" links…). The driver loop
 * now auto-populates it whenever the snapshot held >1 such match (#6), so
 * recorded scripts disambiguate without manual editing; replay treats a missing
 * `nth` as "there must be exactly one match".
 *
 * `qaId` is a stamped `data-qa-id` fallback locator for name-less targets (#9):
 * scriptFromReport copies it through from the StepTarget verbatim. Both fields
 * are inherited from StepTarget (re-declared here only for documentation). */
export interface ScriptTarget extends StepTarget {
  /** 0-based index among role+name matches. Absent → exactly-one-match required. */
  nth?: number;
  /** Stamped `data-qa-id` fallback for name-less targets (best-effort on replay). */
  qaId?: string;
}

export type ScriptStep =
  | { type: 'navigate'; url: string }
  | { type: 'click'; target: ScriptTarget }
  | { type: 'type'; target: ScriptTarget; text: string }
  | { type: 'hover'; target: ScriptTarget }
  | { type: 'press_key'; key: string }
  | { type: 'select_option'; target: ScriptTarget; value: string }
  | { type: 'reload' }
  | { type: 'go_back' }
  | { type: 'assert_dom'; target: ScriptTarget; contains: string }
  // Phase 15: `target` becomes optional and `prompt` is added for the model-
  // assisted mode (nodeId-less extract targeting the whole page). Replay never
  // spends a model call — see replay.ts, which skips prompt-mode extract steps
  // with a warning (replay stays $0/zero-planner-calls).
  | { type: 'extract'; target?: ScriptTarget; key: string; pattern?: string; prompt?: string }
  | { type: 'assert_visual'; expectation: string; mode?: 'screenshot' | 'video' }
  | { type: 'wait'; ms: number }
  // Phase 9 — action parity. `paths` are made portable (relative to cwd) on
  // record; drag_and_drop's `target` (the drop zone) is best-effort — only
  // present when the driver loop resolved a role+name for it (see loop.ts's
  // sourceTarget/targetTarget descriptor fields on the drag_and_drop Action).
  | { type: 'upload_file'; target: ScriptTarget; paths: string[] }
  | { type: 'drag_and_drop'; source: ScriptTarget; target?: ScriptTarget }
  | { type: 'blur'; target: ScriptTarget }
  // Raw page coordinates — inherently less resilient across layout changes
  // than a role+name locator; documented in docs/modules/recorder.md.
  | { type: 'mouse'; kind: 'move' | 'down' | 'up'; x: number; y: number }
  | { type: 'open_tab'; url: string }
  // tabIndex: 0 = the tab active when replay/the script started; N (>=1) = the
  // Nth open_tab call IN THIS SCRIPT (creation order) — never a raw runtime id
  // (those are per-run and would not resolve on replay). See replay.ts.
  | { type: 'switch_tab'; tabIndex: number }
  | { type: 'close_tab'; tabIndex: number }
  // Phase 10 — secure script runner. Persisted verbatim; replay RE-VALIDATES
  // before executing (see replay.ts) — a script step is never trusted just
  // because it was recorded.
  | { type: 'script'; steps: ScriptRunnerStep[] };

export interface QaScript {
  version: 1;
  name: string;
  task: string;
  url: string;
  sourceRunId: string;
  createdAt: string;
  /** Set when self-heal replaced a broken script. */
  healedFrom?: { runId: string; failedStep: number; healedAt: string };
  steps: ScriptStep[];
}

export function taskSlug(task: string): string {
  return (
    task
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'task'
  );
}

/** Distill a PASSED run's steps into replayable script steps. */
export function scriptFromReport(report: Report): QaScript {
  if (report.verdict !== 'pass') {
    throw new Error(`only passed runs are recorded (verdict: ${report.verdict})`);
  }
  /* A navigator that mis-targets a node, notices, and re-clicks the right one
   * is NORMAL recovery — the run still passes and that is the whole point of
   * the loop. But the recorder used to write BOTH clicks into the script, and
   * a replayed no-op click is not harmless: the second one runs against the
   * page the first one produced. Observed on the dogfood fixture (run
   * 2026-08-09_12-19-05-xgx6): the navigator clicked the password StaticText,
   * self-corrected onto the real "Sign in" button, and the emitted script
   * carried `click button "Sign in"` twice — so replay logged in on step 3 and
   * then failed on step 4 with `UI drift: no button "Sign in"`, because a
   * logged-in page has no Sign-in button. A transient mis-click became a
   * permanently broken regression test.
   *
   * Collapsing CONSECUTIVE clicks on the same target is safe: genuine
   * double-click semantics are expressed by the `mouse` verb, never by two
   * independent click steps, and a target that legitimately needs clicking
   * twice in a row (a toggle returning to its prior state) leaves the run in
   * the same place either way. Non-consecutive repeats are untouched — those
   * are real revisits (paginate, add-to-cart twice). */
  const isDuplicateClick = (acc: ScriptStep[], target: StepTarget): boolean => {
    const prev = acc[acc.length - 1];
    return (
      prev?.type === 'click' &&
      prev.target.role === target.role &&
      prev.target.name === target.name &&
      (prev.target.nth ?? 0) === (target.nth ?? 0)
    );
  };

  const steps: ScriptStep[] = [];
  for (const s of report.steps) {
    if (!s.ok) continue; // a passed run can contain a recovered miss — don't replay it
    const a = s.action;
    switch (a.type) {
      case 'navigate':
        steps.push({ type: 'navigate', url: a.url });
        break;
      case 'click':
        if (s.target && !isDuplicateClick(steps, s.target)) steps.push({ type: 'click', target: s.target });
        break;
      case 'type':
        if (s.target) steps.push({ type: 'type', target: s.target, text: a.text });
        break;
      case 'hover':
        if (s.target) steps.push({ type: 'hover', target: s.target });
        break;
      case 'press_key':
        steps.push({ type: 'press_key', key: a.key });
        break;
      case 'select_option':
        if (s.target) steps.push({ type: 'select_option', target: s.target, value: a.value });
        break;
      case 'reload':
        steps.push({ type: 'reload' });
        break;
      case 'go_back':
        steps.push({ type: 'go_back' });
        break;
      case 'assert_dom':
        if (s.target) steps.push({ type: 'assert_dom', target: s.target, contains: a.contains });
        break;
      case 'extract':
        if (a.prompt) {
          // model-assisted: no target required (may target the whole page)
          steps.push({ type: 'extract', key: a.key, prompt: a.prompt, ...(s.target && { target: s.target }) });
        } else if (s.target) {
          steps.push({ type: 'extract', target: s.target, key: a.key, ...(a.pattern && { pattern: a.pattern }) });
        }
        break;
      case 'assert_visual':
        steps.push({ type: 'assert_visual', expectation: a.expectation, ...(a.mode && { mode: a.mode }) });
        break;
      case 'wait':
        steps.push({ type: 'wait', ms: a.ms });
        break;
      case 'upload_file':
        if (s.target) steps.push({ type: 'upload_file', target: s.target, paths: a.paths.map(portablePath) });
        break;
      case 'drag_and_drop':
        // sourceTarget/targetTarget are resolved by the driver loop AFTER
        // execution (see loop.ts) — never model-emitted. Without a sourceTarget
        // there is nothing resilient to replay, so the step is skipped (same
        // "no target, no recording" convention as click/hover/select_option).
        if (a.sourceTarget) {
          steps.push({
            type: 'drag_and_drop',
            source: { role: a.sourceTarget.role, ...(a.sourceTarget.name && { name: a.sourceTarget.name }), ...(a.sourceTarget.nth !== undefined && { nth: a.sourceTarget.nth }) },
            ...(a.targetTarget && {
              target: { role: a.targetTarget.role, ...(a.targetTarget.name && { name: a.targetTarget.name }), ...(a.targetTarget.nth !== undefined && { nth: a.targetTarget.nth }) },
            }),
          });
        }
        break;
      case 'blur':
        if (s.target) steps.push({ type: 'blur', target: s.target });
        break;
      case 'mouse':
        steps.push({ type: 'mouse', kind: a.kind, x: a.x, y: a.y });
        break;
      case 'open_tab':
        steps.push({ type: 'open_tab', url: a.url });
        break;
      case 'switch_tab':
        steps.push({ type: 'switch_tab', tabIndex: tabIndexFor(report.steps, s.index, a.tabId) });
        break;
      case 'close_tab':
        steps.push({ type: 'close_tab', tabIndex: tabIndexFor(report.steps, s.index, a.tabId) });
        break;
      case 'script':
        steps.push({ type: 'script', steps: a.steps });
        break;
      case 'finish':
        // the pass-confirmation visual is part of the recorded contract
        steps.push({
          type: 'assert_visual',
          expectation: `The task "${report.task}" should have completed successfully. Does the page show a sensible end state for it (no error banners, no blank page)?`,
        });
        break;
    }
  }
  return {
    version: 1,
    name: taskSlug(report.task),
    task: report.task,
    url: report.url,
    sourceRunId: report.runId,
    createdAt: new Date().toISOString(),
    steps,
  };
}

/** Make an upload_file path portable: absolute paths become relative to cwd
 * (so a script recorded on one machine still reads sensibly on another /
 * checked into git); already-relative paths pass through unchanged. Never
 * touches the CONTENTS of the path — a path containing `{{secret:...}}` (a
 * user pointing at a secret-derived filename) is rejected outright, since
 * upload_file paths must never embed secrets. */
function portablePath(p: string): string {
  if (/\{\{secret:/i.test(p)) {
    throw new Error(`upload_file path must not reference a secret: ${p}`);
  }
  return path.isAbsolute(p) ? path.relative(process.cwd(), p) : p;
}

/** Resolve a switch_tab/close_tab StepRecord's raw runtime `tabId` to a
 * REPLAYABLE index: 0 = the tab active when the script starts; N (>=1) = the
 * Nth open_tab call (creation order) IN THIS REPORT whose returned id matches.
 * A runtime CDP target id would not exist on a later replay run — the index
 * is what actually survives. Falls back to 0 (the original tab) when the id
 * doesn't match any recorded open_tab (e.g. switching/closing the tab that
 * was active before any open_tab call). */
function tabIndexFor(steps: StepRecord[], uptoIndex: number, tabId: string): number {
  let n = 0;
  for (const s of steps) {
    if (s.index > uptoIndex) break;
    if (s.action.type === 'open_tab') {
      n++;
      if (s.target?.name === tabId) return n;
    }
  }
  return 0;
}

/* ---------- persistence ---------- */

export function scriptsDir(root = process.cwd()): string {
  return path.join(root, 'generated-tests');
}

export function saveScript(script: QaScript, root = process.cwd()): { jsonPath: string; specPath: string } {
  const dir = scriptsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, `${script.name}.json`);
  const specPath = path.join(dir, `${script.name}.spec.ts`);
  fs.writeFileSync(jsonPath, JSON.stringify(script, null, 2));
  fs.writeFileSync(specPath, toPlaywrightSpec(script));
  return { jsonPath, specPath };
}

// Phase-14+ callers (matchReplayScript in particular) call loadScript() once
// per recorded script on EVERY invocation — cache the parsed result per
// resolved path, keyed by mtime, so an unchanged script isn't re-read/re-parsed
// off disk on every call within the same process. Invalidated automatically
// the moment a script's mtime changes (re-record, self-heal re-emit, …).
const scriptCache = new Map<string, { mtimeMs: number; script: QaScript }>();

export function loadScript(nameOrPath: string, root = process.cwd()): QaScript {
  const p = nameOrPath.endsWith('.json')
    ? path.resolve(nameOrPath)
    : path.join(scriptsDir(root), `${taskSlug(nameOrPath)}.json`);
  if (!fs.existsSync(p)) throw new Error(`no recorded script at ${p} — record one with a passing \`spike run\``);
  const mtimeMs = fs.statSync(p).mtimeMs;
  const cached = scriptCache.get(p);
  if (cached && cached.mtimeMs === mtimeMs) return cached.script;
  // A14: JSON.parse alone is a TypeScript-only assertion, not a runtime check
  // — a hand-written or hand-edited script (the direct answer to "I don't
  // want the AI hallucinating in my regression suite") deserves a real
  // validation gate, failing loudly at load time with the specific field(s)
  // that are wrong rather than blowing up obscurely deep inside replay.
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    throw new Error(`malformed script at ${p}: not valid JSON (${(err as Error).message})`);
  }
  const result = validateQaScript(raw);
  if (!result.ok) {
    const shown = result.errors.slice(0, 5);
    const more = result.errors.length > shown.length ? `\n  ...and ${result.errors.length - shown.length} more` : '';
    throw new Error(`invalid script at ${p}:\n  ${shown.join('\n  ')}${more}`);
  }
  const script = result.script;
  scriptCache.set(p, { mtimeMs, script });
  return script;
}

export function listScripts(root = process.cwd()): string[] {
  const dir = scriptsDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(dir, f));
}

/* ---------- heal diff report ---------- */

/** A one-line-per-change, human-readable diff between two scripts, compared by
 * index. Used in the self-heal path to show WHAT the AI re-recording changed
 * (drift fixes show up as "changed" steps; added/removed flow steps as such).
 *
 * Comparison key per step: type + target (role/name/nth) + text/contains/url —
 * everything that affects replay. Returns "no changes" when identical. */
export function diffScripts(oldS: QaScript, newS: QaScript): string {
  const a = oldS.steps;
  const b = newS.steps;
  const n = Math.max(a.length, b.length);
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const o = a[i];
    const w = b[i];
    if (o && !w) {
      lines.push(`- [${i}] removed: ${stepSig(o)}`);
    } else if (!o && w) {
      lines.push(`+ [${i}] added: ${stepSig(w)}`);
    } else if (o && w) {
      const so = stepSig(o);
      const sw = stepSig(w);
      if (so !== sw) lines.push(`~ [${i}] changed: ${so}  →  ${sw}`);
    }
  }
  const changed = lines.length;
  const header =
    changed === 0
      ? `no changes (${a.length} step(s))`
      : `${changed} change(s) across ${a.length}→${b.length} steps`;
  return changed === 0 ? header : `${header}\n${lines.join('\n')}`;
}

/** A compact, comparable signature of a step — what diffScripts compares on. */
function stepSig(s: ScriptStep): string {
  switch (s.type) {
    case 'navigate':
      return `navigate ${s.url}`;
    case 'click':
      return `click ${targetSig(s.target)}`;
    case 'type':
      return `type ${JSON.stringify(s.text)} → ${targetSig(s.target)}`;
    case 'hover':
      return `hover ${targetSig(s.target)}`;
    case 'press_key':
      return `press_key ${JSON.stringify(s.key)}`;
    case 'select_option':
      return `select_option ${JSON.stringify(s.value)} → ${targetSig(s.target)}`;
    case 'reload':
      return 'reload';
    case 'go_back':
      return 'go_back';
    case 'assert_dom':
      return `assert_dom ${targetSig(s.target)} contains ${JSON.stringify(s.contains)}`;
    case 'extract':
      return s.prompt
        ? `extract ${s.key} (model-assisted: ${JSON.stringify(s.prompt.slice(0, 60))})`
        : `extract ${s.key} from ${s.target ? targetSig(s.target) : 'page'}${s.pattern ? ` matching ${JSON.stringify(s.pattern)}` : ''}`;
    case 'assert_visual':
      return `assert_visual${s.mode ? `:${s.mode}` : ''} ${JSON.stringify(s.expectation.slice(0, 60))}`;
    case 'wait':
      return `wait ${s.ms}ms`;
    case 'upload_file':
      return `upload_file ${JSON.stringify(s.paths)} → ${targetSig(s.target)}`;
    case 'drag_and_drop':
      return `drag_and_drop ${targetSig(s.source)} → ${s.target ? targetSig(s.target) : '?'}`;
    case 'blur':
      return `blur ${targetSig(s.target)}`;
    case 'mouse':
      return `mouse ${s.kind} (${s.x}, ${s.y})`;
    case 'open_tab':
      return `open_tab ${s.url}`;
    case 'switch_tab':
      return `switch_tab #${s.tabIndex}`;
    case 'close_tab':
      return `close_tab #${s.tabIndex}`;
    case 'script':
      return `script (${s.steps.length} step(s))`;
  }
}

function targetSig(t: ScriptTarget): string {
  const nth = typeof t.nth === 'number' ? `#${t.nth}` : '';
  return `${t.role}${nth}"${t.name ?? ''}"`;
}

/* ---------- Playwright-flavoured translation (reference rendering, NOT a
 * runnable test — see toPlaywrightSpec's header comment; A16) ---------- */

const ROLE_MAP: Record<string, string> = {
  button: 'button',
  link: 'link',
  textbox: 'textbox',
  searchbox: 'searchbox',
  checkbox: 'checkbox',
  radio: 'radio',
  combobox: 'combobox',
  heading: 'heading',
  alert: 'alert',
};

function locator(target: ScriptTarget): string {
  // #9: a name-less target with a stamped data-qa-id codegens the attribute
  // locator (resilient, no nth needed — the id is unique on the page).
  if (!target.name && target.qaId) {
    return `page.locator(${JSON.stringify(`[data-qa-id="${target.qaId}"]`)})`;
  }
  const role = ROLE_MAP[target.role] ?? target.role;
  const base = target.name
    ? `page.getByRole(${JSON.stringify(role)}, { name: ${JSON.stringify(target.name)} })`
    : `page.getByRole(${JSON.stringify(role)})`;
  return typeof target.nth === 'number' ? `${base}.nth(${target.nth})` : base;
}

/** Emit a Playwright-flavoured TRANSLATION of a recorded script — a
 * human-readable reference rendering, NOT an executable test (A16).
 * `spike replay <name>` is the one executable form of this script (the JSON
 * twin, zero planner calls, $0 visual checks via on-device Nano).
 *
 * Making this genuinely runnable would need, at minimum: a `@playwright/test`
 * dependency + generated `playwright.config.ts` (neither exists in this repo
 * — deliberately; shipping a Playwright-library product shape was DROPPED,
 * see `docs/plan/2026-07-07-passmark-gap-implementation-tasks.md:225`),
 * resolution of `{{secret:*}}` / `{{run.*}}` placeholders into real values
 * (emitted verbatim below as unresolved literals), and a real translation for
 * `extract` / the tab verbs / the `script` sub-DSL, which route through
 * spike's own judgement or secure script runner on replay and have no 1:1
 * Playwright API — so they're emitted as comments only, same as before. */
export function toPlaywrightSpec(script: QaScript): string {
  const lines: string[] = [];
  for (const s of script.steps) {
    switch (s.type) {
      case 'navigate':
        lines.push(`  await page.goto(${JSON.stringify(s.url)});`);
        break;
      case 'click':
        lines.push(`  await ${locator(s.target)}.click();`);
        break;
      case 'type':
        lines.push(`  await ${locator(s.target)}.fill(${JSON.stringify(s.text)});`);
        break;
      case 'hover':
        lines.push(`  await ${locator(s.target)}.hover();`);
        break;
      case 'press_key':
        lines.push(`  await page.keyboard.press(${JSON.stringify(s.key)});`);
        break;
      case 'select_option':
        lines.push(`  await ${locator(s.target)}.selectOption(${JSON.stringify(s.value)});`);
        break;
      case 'reload':
        lines.push(`  await page.reload();`);
        break;
      case 'go_back':
        lines.push(`  await page.goBack();`);
        break;
      case 'assert_dom':
        lines.push(`  await expect(${locator(s.target)}).toContainText(${JSON.stringify(s.contains)});`);
        break;
      case 'extract':
        lines.push(
          s.prompt
            ? `  // extract ${s.key} (model-assisted, judged by the QA subagent when replayed via \`spike replay\`): ${s.prompt.replace(/\n/g, ' ')}`
            : `  // extract ${s.key} from ${s.target ? locator(s.target) : 'the page'}${s.pattern ? ` using ${JSON.stringify(s.pattern)}` : ''}`,
        );
        break;
      case 'assert_visual':
        lines.push(`  // ${s.mode === 'video' ? 'video' : 'visual'} check — judged by the QA subagent when replayed via \`spike replay\`, not by this file:`);
        lines.push(`  // TODO(assertion): ${s.expectation.replace(/\n/g, ' ')}`);
        break;
      case 'wait':
        lines.push(`  await page.waitForTimeout(${s.ms});`);
        break;
      case 'upload_file':
        lines.push(`  await ${locator(s.target)}.setInputFiles(${JSON.stringify(s.paths)});`);
        break;
      case 'drag_and_drop':
        if (s.target) {
          lines.push(`  await ${locator(s.source)}.dragTo(${locator(s.target)});`);
        } else {
          lines.push(`  // drag_and_drop ${locator(s.source)} → (drop target not resolved when recorded)`);
        }
        break;
      case 'blur':
        lines.push(`  await ${locator(s.target)}.blur();`);
        break;
      case 'mouse':
        lines.push(
          s.kind === 'move'
            ? `  await page.mouse.move(${s.x}, ${s.y});`
            : s.kind === 'down'
              ? `  await page.mouse.move(${s.x}, ${s.y}); await page.mouse.down();`
              : `  await page.mouse.move(${s.x}, ${s.y}); await page.mouse.up();`,
        );
        break;
      case 'open_tab':
        lines.push(`  // open_tab ${s.url} — judged by the QA subagent's replay (Playwright: use context.newPage())`);
        break;
      case 'switch_tab':
        lines.push(`  // switch_tab #${s.tabIndex} — judged by the QA subagent's replay (Playwright: track pages[] from context.newPage())`);
        break;
      case 'close_tab':
        lines.push(`  // close_tab #${s.tabIndex} — judged by the QA subagent's replay (Playwright: page.close() on the tracked page)`);
        break;
      case 'script':
        lines.push(`  // script (${s.steps.length} step(s)) — judged by the QA subagent's replay (secure script runner, not translated here)`);
        break;
    }
  }
  return `/* GENERATED — reference rendering, NOT a runnable test.
 *
 * A human-readable Playwright-flavoured TRANSLATION of a recorded spike-agent
 * script, from passing run ${script.sourceRunId}. It exists for review/diff,
 * not execution: spike never runs this file, and as emitted it also cannot
 * run under \`playwright test\` as-is —
 *   - no @playwright/test dependency or playwright.config.ts in this repo
 *   - {{secret:*}} / {{run.*}} placeholders below (if any) are UNRESOLVED
 *     literals, not real values
 *   - extract / open_tab / switch_tab / close_tab / script steps are
 *     comments only — they route through spike's own judgement or secure
 *     script runner on replay, with no 1:1 Playwright API
 *
 * The EXECUTABLE form of this script is:
 *   spike replay ${script.name}
 * (zero planner calls on replay; $0 visual checks via on-device Nano.)
 *
 * Task: ${script.task.replace(/\n/g, ' ')}
 */
import { test, expect } from '@playwright/test';

test(${JSON.stringify(script.task)}, async ({ page }) => {
  await page.goto(${JSON.stringify(script.url)});
${lines.join('\n')}
});
`;
}
