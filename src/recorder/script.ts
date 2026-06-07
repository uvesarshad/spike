/* Recorded QA scripts — "AI once → deterministic forever".
 *
 * A passed run is distilled into a JSON script of resilient steps (role+name
 * locators, never nodeIds). `qa replay` executes that JSON over CDP with zero
 * planner calls. A Playwright `.spec.ts` twin is emitted alongside as a
 * PORTABLE artifact for the user's own test suite/CI — we never execute it
 * (no Playwright dependency here). */

import fs from 'node:fs';
import path from 'node:path';
import type { Report, StepTarget } from '../report/report.js';

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
  | { type: 'assert_dom'; target: ScriptTarget; contains: string }
  | { type: 'assert_visual'; expectation: string }
  | { type: 'wait'; ms: number };

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
  const steps: ScriptStep[] = [];
  for (const s of report.steps) {
    if (!s.ok) continue; // a passed run can contain a recovered miss — don't replay it
    const a = s.action;
    switch (a.type) {
      case 'navigate':
        steps.push({ type: 'navigate', url: a.url });
        break;
      case 'click':
        if (s.target) steps.push({ type: 'click', target: s.target });
        break;
      case 'type':
        if (s.target) steps.push({ type: 'type', target: s.target, text: a.text });
        break;
      case 'assert_dom':
        if (s.target) steps.push({ type: 'assert_dom', target: s.target, contains: a.contains });
        break;
      case 'assert_visual':
        steps.push({ type: 'assert_visual', expectation: a.expectation });
        break;
      case 'wait':
        steps.push({ type: 'wait', ms: a.ms });
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

export function loadScript(nameOrPath: string, root = process.cwd()): QaScript {
  const p = nameOrPath.endsWith('.json')
    ? path.resolve(nameOrPath)
    : path.join(scriptsDir(root), `${taskSlug(nameOrPath)}.json`);
  if (!fs.existsSync(p)) throw new Error(`no recorded script at ${p} — record one with a passing \`qa run\``);
  return JSON.parse(fs.readFileSync(p, 'utf8')) as QaScript;
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
    case 'assert_dom':
      return `assert_dom ${targetSig(s.target)} contains ${JSON.stringify(s.contains)}`;
    case 'assert_visual':
      return `assert_visual ${JSON.stringify(s.expectation.slice(0, 60))}`;
    case 'wait':
      return `wait ${s.ms}ms`;
  }
}

function targetSig(t: ScriptTarget): string {
  const nth = typeof t.nth === 'number' ? `#${t.nth}` : '';
  return `${t.role}${nth}"${t.name ?? ''}"`;
}

/* ---------- Playwright codegen (portable artifact) ---------- */

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
    ? `page.getByRole('${role}', { name: ${JSON.stringify(target.name)} })`
    : `page.getByRole('${role}')`;
  return typeof target.nth === 'number' ? `${base}.nth(${target.nth})` : base;
}

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
      case 'assert_dom':
        lines.push(`  await expect(${locator(s.target)}).toContainText(${JSON.stringify(s.contains)});`);
        break;
      case 'assert_visual':
        lines.push(`  // visual check (judged by the QA subagent's vision model when replayed via \`qa replay\`):`);
        lines.push(`  // ${s.expectation.replace(/\n/g, ' ')}`);
        lines.push(`  await expect(page.locator('body')).toBeVisible();`);
        break;
      case 'wait':
        lines.push(`  await page.waitForTimeout(${s.ms});`);
        break;
    }
  }
  return `// Generated by browser-qa-subagent from passing run ${script.sourceRunId}
// Task: ${script.task.replace(/\n/g, ' ')}
// Replay without Playwright (and with $0 visual checks): qa replay ${script.name}
import { test, expect } from '@playwright/test';

test(${JSON.stringify(script.task)}, async ({ page }) => {
  await page.goto(${JSON.stringify(script.url)});
${lines.join('\n')}
});
`;
}
