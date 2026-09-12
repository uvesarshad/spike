/* v87 — A16 (P1): a click that changes nothing must say so.
 *
 * The driver already compared the page before and after every click, but the
 * answer was only used to decide whether the action was worth remembering for a
 * later $0 re-run. A button with nothing wired to it — the single most common
 * bug in a hand-assembled app — therefore produced a green step and vanished
 * from the report.
 *
 * Covers (no Chrome, no AI — a fake BrowserPort whose page never reacts):
 *   1. a click that changes nothing stamps a warn-level 'dead-interaction'
 *      check on that step, with the button's name in the sentence;
 *   2. it is a WARNING, not a failure — the step itself stays ok and the run is
 *      not force-failed by it;
 *   3. a click that DOES change the page trips nothing;
 *   4. the check rides along in the action history both models read.
 *
 * Run: npx tsx test/v87.dead-interaction.ts   (exits nonzero on any failed check)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDriverLoop } from '../src/driver/loop.js';
import { ArtifactStore } from '../src/report/artifacts.js';
import { ModelRouter } from '../src/router/model-router.js';
import { buildNavigatorPrompt } from '../src/driver/planner-prompt.js';
import type { Capability, JsonRequest, ModelAdapter } from '../src/router/adapter.js';
import type { AxNode, AxSnapshot, BrowserPort, ConsoleEntry, LogpointSpec, NetworkEntry } from '../src/ports/browser-port.js';
import type { StepRecord } from '../src/report/report.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

/** A page with one button. `reacts` decides whether pressing it changes
 * anything an outside observer could see. */
class FakeBrowser implements BrowserPort {
  pressed = 0;
  constructor(
    private readonly reacts: boolean,
    public currentUrl = 'https://shop.example.com/checkout',
  ) {}
  private tree(): AxNode {
    return {
      id: 'root',
      role: 'WebArea',
      children: [
        { id: 'n1', role: 'button', name: 'Place order' },
        ...(this.reacts && this.pressed > 0 ? [{ id: 'n2', role: 'status', name: 'Order placed' } as AxNode] : []),
      ],
    };
  }
  async launch(): Promise<void> {}
  async navigate(url: string): Promise<void> {
    this.currentUrl = url;
  }
  async url(): Promise<string> {
    return this.currentUrl;
  }
  async axTree(): Promise<AxSnapshot> {
    const root = this.tree();
    return { root, text: JSON.stringify(root), truncated: false };
  }
  async click(): Promise<void> {
    this.pressed++;
  }
  async type(): Promise<void> {}
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

/** Clicks the button, then finishes — so the run is short and deterministic. */
function stubNavigator(): ModelAdapter {
  let call = 0;
  return {
    name: 'stub-navigator',
    rung: 1,
    available: async () => true,
    supports: (c: Capability) => c === 'plan-step',
    generateJson: async (_req: JsonRequest) => {
      call++;
      if (call === 1) return { thought: 'press the button', actions: [{ type: 'click', nodeId: 'n1' }] };
      return { thought: 'done', actions: [{ type: 'finish', verdict: 'pass', reason: 'pressed the button' }] };
    },
  };
}

function tmpArtifacts(): ArtifactStore {
  return new ArtifactStore(fs.mkdtempSync(path.join(os.tmpdir(), 'spike-art-')));
}

async function run(reacts: boolean) {
  const browser = new FakeBrowser(reacts);
  const router = new ModelRouter([stubNavigator()]);
  const report = await runDriverLoop(browser, router, tmpArtifacts(), 'place an order', browser.currentUrl, {
    maxSteps: 6,
    allowedHosts: ['shop.example.com'],
  });
  return { browser, report };
}

console.log('=== v87 1/3: a button with nothing wired to it ===');
{
  const { browser, report } = await run(false);
  const clickStep = report.steps.find((s) => s.action.type === 'click');
  const dead = clickStep?.invariants?.find((v) => v.rule === 'dead-interaction');

  check('the click really reached the page', browser.pressed === 1);
  check('the click step carries a dead-interaction check', !!dead);
  check('the sentence names the button', !!dead && dead.detail.includes('Place order'));
  check('the sentence is plain English', !!dead && dead.detail.includes('changed nothing on the page'));
  check('it is a warning, not an error', dead?.severity === 'warn');
  check('the step itself is still recorded as ok', clickStep?.ok === true);
  check('the run is not force-failed by the warning', report.verdict !== 'fail');
}

console.log('\n=== v87 2/3: a button that does react ===');
{
  const { browser, report } = await run(true);
  const clickStep = report.steps.find((s) => s.action.type === 'click');
  check('the click reached the page', browser.pressed === 1);
  check(
    'no dead-interaction check is raised',
    !clickStep?.invariants?.some((v) => v.rule === 'dead-interaction'),
  );
}

console.log('\n=== v87 3/3: the warning rides along in the action history ===');
{
  const step: StepRecord = {
    index: 0,
    action: { type: 'click', nodeId: 'n1' },
    description: 'Click button "Place order"',
    ok: true,
    console: [],
    network: [],
    ts: Date.now(),
    invariants: [{ rule: 'dead-interaction', severity: 'warn', detail: 'clicking "Place order" changed nothing on the page' }],
  };
  const prompt = buildNavigatorPrompt({
    task: 'place an order',
    url: 'https://shop.example.com/checkout',
    axText: 'n1 button "Place order"',
    goal: 'place an order',
    goals: ['place an order'],
    currentGoal: 0,
    history: [step],
    stepIndex: 1,
    maxSteps: 10,
  });
  check('the history shows the check', prompt.includes('clicking "Place order" changed nothing on the page'));
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) process.exit(1);
