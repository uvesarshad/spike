/**
 * V31 - driver-level action-cache wiring.
 *
 * Run: npx tsx test/v31.action-cache-driver.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileActionCache } from '../src/cache/action-cache.js';
import { runDriverLoop } from '../src/driver/loop.js';
import { ArtifactStore } from '../src/report/artifacts.js';
import type { AxNode, AxSnapshot, BrowserPort, ConsoleEntry, NetworkEntry } from '../src/ports/browser-port.js';
import type { ModelRouter } from '../src/router/model-router.js';

class FakeBrowser implements BrowserPort {
  private currentUrl = 'about:blank';
  clicked = false;

  async launch(): Promise<void> {}

  async navigate(url: string): Promise<void> {
    this.currentUrl = url;
    this.clicked = false;
  }

  async url(): Promise<string> {
    return this.currentUrl;
  }

  async axTree(): Promise<AxSnapshot> {
    const root: AxNode = {
      id: 'root',
      role: 'document',
      name: 'Fake app',
      children: [
        { id: 'n1', role: 'button', name: 'Continue' },
        { id: 'n2', role: 'status', name: this.clicked ? 'Clicked' : 'Not clicked' },
      ],
    };
    return {
      root,
      text: `document "Fake app"\n  button "Continue"\n  status "${this.clicked ? 'Clicked' : 'Not clicked'}"`,
      truncated: false,
    };
  }

  async click(nodeId: string): Promise<void> {
    assert.equal(nodeId, 'n1');
    this.clicked = true;
  }

  async type(): Promise<void> {}
  async hover(): Promise<void> {}
  async pressKey(): Promise<void> {}
  async selectOption(): Promise<void> {}
  async reload(): Promise<void> {}
  async goBack(): Promise<void> {}
  async screenshot(): Promise<Buffer> {
    return Buffer.from('fake-png');
  }
  async setLogpoint(): Promise<void> {}
  drainConsole(): ConsoleEntry[] {
    return [];
  }
  drainNetwork(): NetworkEntry[] {
    return [];
  }
  async close(): Promise<void> {}
}

function fakeRouter(planQueue: unknown[]) {
  let planCalls = 0;
  return {
    trace: [],
    get planCalls() {
      return planCalls;
    },
    async hasCapability(): Promise<boolean> {
      return false;
    },
    async planJson(): Promise<unknown> {
      planCalls++;
      const next = planQueue.shift();
      assert.ok(next, 'expected queued navigator plan');
      return next;
    },
    async visualVerdict(): Promise<unknown> {
      return { verdict: 'pass', summary: 'ok', issues: [] };
    },
  } as unknown as ModelRouter & { planCalls: number };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-cache-driver-'));
const artifactsRoot = path.join(root, 'artifacts');
const cache = new FileActionCache(path.join(root, 'cache'));

const firstRouter = fakeRouter([
  { thought: 'click the button', actions: [{ type: 'click', nodeId: 'n1' }] },
  { thought: 'done', actions: [{ type: 'finish', verdict: 'pass', reason: 'button clicked' }] },
]);
const firstReport = await runDriverLoop(
  new FakeBrowser(),
  firstRouter,
  new ArtifactStore(artifactsRoot),
  'click continue',
  'http://localhost/cache-driver',
  { maxSteps: 6, actionCache: cache },
);

assert.equal(firstReport.verdict, 'pass');
assert.equal(firstReport.action_cache?.enabled, true);
assert.equal(firstReport.action_cache?.stored, 1);
assert.equal(firstRouter.planCalls, 2);

const secondRouter = fakeRouter([
  { thought: 'done after cached click', actions: [{ type: 'finish', verdict: 'pass', reason: 'cached click worked' }] },
]);
const secondReport = await runDriverLoop(
  new FakeBrowser(),
  secondRouter,
  new ArtifactStore(artifactsRoot),
  'click continue',
  'http://localhost/cache-driver',
  { maxSteps: 6, actionCache: cache },
);

assert.equal(secondReport.verdict, 'pass');
assert.equal(secondReport.action_cache?.hits, 1);
assert.equal(secondRouter.planCalls, 1);
assert.equal(secondReport.steps[0]?.thought, 'cached action');
assert.equal(secondReport.steps[0]?.action.type, 'click');

console.log('\nV31 action-cache driver checks passed (8).');
