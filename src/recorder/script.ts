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

export type ScriptStep =
  | { type: 'navigate'; url: string }
  | { type: 'click'; target: StepTarget }
  | { type: 'type'; target: StepTarget; text: string }
  | { type: 'assert_dom'; target: StepTarget; contains: string }
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

function locator(target: StepTarget): string {
  const role = ROLE_MAP[target.role] ?? target.role;
  return target.name
    ? `page.getByRole('${role}', { name: ${JSON.stringify(target.name)} })`
    : `page.getByRole('${role}')`;
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
