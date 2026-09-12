/* v73 — A1 (P0): a look-only run must be honest about what it refused.
 *
 * Before this, a mutating action skipped because look-only mode was on was
 * stamped `ok: true` with a "skipped …" description: the report, the plain
 * report and the fix prompt all showed a column of green ticks that said
 * "skipped". Neither prompt was told look-only was on, so the navigator
 * re-issued the same click, the identical-tree repeat detector fired, and the
 * run ended blaming the site — "repeated the same action 3×" — on a site that
 * was never touched.
 *
 * Covers (no Chrome, no AI — a fake BrowserPort + a scripted navigator that
 * keeps proposing the same click):
 *   1. a skipped mutation is recorded ok:false with error 'skipped: look-only mode';
 *   2. the browser really never received the click;
 *   3. the run ends `uncertain` with a reason that NAMES look-only mode, not
 *      "repeated the same action 3×";
 *   4. both prompts carry the LOOK-ONLY MODE line when (and only when) it's on.
 *
 * Run: npx tsx test/v73.look-only-loop.ts   (exits nonzero on any failed check)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDriverLoop } from '../src/driver/loop.js';
import { ArtifactStore } from '../src/report/artifacts.js';
import { ModelRouter } from '../src/router/model-router.js';
import { buildNavigatorPrompt, buildGoalPlannerPrompt } from '../src/driver/planner-prompt.js';
import type { Capability, JsonRequest, ModelAdapter } from '../src/router/adapter.js';
import type {
  AxNode,
  AxSnapshot,
  BrowserPort,
  ConsoleEntry,
  LogpointSpec,
  NetworkEntry,
} from '../src/ports/browser-port.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

function fakeTree(): AxNode {
  return {
    id: 'root',
    role: 'WebArea',
    children: [
      { id: 'n1', role: 'textbox', name: 'Email' },
      { id: 'n2', role: 'button', name: 'Delete account' },
    ],
  };
}

/** Fake BrowserPort. The tree never changes — exactly the situation the
 * identical-tree repeat detector was designed for, and exactly the situation a
 * look-only run produces by construction. */
class FakeBrowser implements BrowserPort {
  clicked: string[] = [];
  typed: { nodeId: string; text: string }[] = [];
  constructor(public currentUrl: string) {}
  async launch(): Promise<void> {}
  async navigate(url: string): Promise<void> {
    this.currentUrl = url;
  }
  async url(): Promise<string> {
    return this.currentUrl;
  }
  async axTree(): Promise<AxSnapshot> {
    return { root: fakeTree(), text: 'textbox "Email" n1\nbutton "Delete account" n2', truncated: false };
  }
  async click(nodeId: string): Promise<void> {
    this.clicked.push(nodeId);
  }
  async type(nodeId: string, text: string): Promise<void> {
    this.typed.push({ nodeId, text });
  }
  async hover(): Promise<void> {}
  async pressKey(): Promise<void> {}
  async selectOption(): Promise<void> {}
  async reload(): Promise<void> {}
  async goBack(): Promise<void> {}
  async uploadFile(): Promise<void> {}
  async dragAndDrop(): Promise<void> {}
  async blur(): Promise<void> {}
  async mouse(): Promise<void> {}
  async openTab(): Promise<string> {
    return 'tab-0';
  }
  async switchTab(): Promise<void> {}
  async closeTab(): Promise<void> {}
  async screenshot(): Promise<Buffer> {
    return Buffer.from('\x89PNG\r\n\x1a\n', 'binary');
  }
  async setLogpoint(_spec: LogpointSpec): Promise<void> {}
  drainConsole(): ConsoleEntry[] {
    return [];
  }
  drainNetwork(): NetworkEntry[] {
    return [];
  }
  async close(): Promise<void> {}
}

/** A navigator that only ever proposes the same click — the behaviour a model
 * that has not been told about look-only mode actually exhibits. */
function stubNavigator(plan: unknown): ModelAdapter {
  return {
    name: 'stub-navigator',
    rung: 1,
    available: async () => true,
    supports: (c: Capability) => c === 'plan-step',
    generateJson: async (_req: JsonRequest) => plan,
  };
}

function tmpArtifacts(): ArtifactStore {
  return new ArtifactStore(fs.mkdtempSync(path.join(os.tmpdir(), 'spike-art-')));
}

/* ============ 1) a look-only run that keeps proposing a click ============ */
console.log('=== v73 1/2: a refused click is never recorded as a success ===');
{
  const browser = new FakeBrowser('https://shop.example.com/account');
  const router = new ModelRouter([
    stubNavigator({ thought: 'remove the account', actions: [{ type: 'click', nodeId: 'n2' }] }),
  ]);
  const report = await runDriverLoop(browser, router, tmpArtifacts(), 'delete my account', 'https://shop.example.com/account', {
    maxSteps: 20,
    // the host IS allowed — this is look-only mode, not the host guard
    allowedHosts: ['shop.example.com'],
    readOnly: true,
  });

  check('the browser never received the click', browser.clicked.length === 0);
  check('the run produced steps (the refusals are visible)', report.steps.length > 0);
  check(
    'every refused mutation is recorded ok:false',
    report.steps.filter((s) => s.action.type === 'click').every((s) => s.ok === false),
  );
  check(
    "each refusal carries error 'skipped: look-only mode'",
    report.steps.filter((s) => s.action.type === 'click').every((s) => s.error === 'skipped: look-only mode'),
  );
  check(
    'the step description says look-only, not read-only',
    report.steps.some((s) => s.description.startsWith('look-only mode: skipped')),
  );
  check('verdict is uncertain', report.verdict === 'uncertain');
  check('the reason names look-only mode', /look-only mode/.test(report.reason));
  check(
    'the reason does NOT blame a repeated action',
    !/repeated the same action/i.test(report.reason),
  );
  check('the reason tells the user what to do about it', /look-only mode off/.test(report.reason));
}

/* ============ 2) both prompts are told ============ */
console.log('\n=== v73 2/2: the prompts know look-only is on ===');
{
  const NOTICE = 'LOOK-ONLY MODE: you may navigate and observe but clicks/typing will be refused; use assert_*/finish instead of interacting';
  const navBase = {
    task: 'buy a widget',
    url: 'https://shop.example.com/',
    axText: 'button "Buy" n1',
    goal: 'add a widget to the cart',
    goals: ['add a widget to the cart'],
    currentGoal: 0,
    history: [],
    stepIndex: 0,
    maxSteps: 40,
  };
  check('navigator prompt carries the notice when look-only is on', buildNavigatorPrompt({ ...navBase, readOnly: true }).includes(NOTICE));
  check('navigator prompt is unchanged when it is off', !buildNavigatorPrompt(navBase).includes('LOOK-ONLY'));

  const brainBase = { task: 'buy a widget', url: 'https://shop.example.com/', axText: 'button "Buy" n1' };
  check('planning prompt carries the notice when look-only is on', buildGoalPlannerPrompt({ ...brainBase, readOnly: true }).includes(NOTICE));
  check('planning prompt is unchanged when it is off', !buildGoalPlannerPrompt(brainBase).includes('LOOK-ONLY'));
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v73 checks passed`);
process.exit(failed.length ? 1 : 0);
