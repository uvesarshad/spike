/* v67 - discovery app-model fed into the brain's goal-planner prompt.
 *
 * loop.ts's loadSiteMapSummary() reads `.spike/app-model.json` (the SAME file
 * `spike map` / src/discovery/ writes via saveAppModel/loadAppModel), checks
 * it covers the run's target host, and — when fresh enough — summarizes it
 * (route list + per-route key elements, capped ~300 tokens) into a
 * "KNOWN SITE MAP" section buildGoalPlannerPrompt appends right after the
 * current page. Part A unit-tests the prompt builder directly; Part B proves
 * the wiring end-to-end through runDriverLoop (host match / mismatch / no
 * file / stale file).
 *
 * Run: npx tsx test/v67.sitemap-prompt.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildGoalPlannerPrompt } from '../src/driver/planner-prompt.js';
import { APP_MODEL_VERSION, saveAppModel, type AppModel } from '../src/discovery/index.js';
import { runDriverLoop } from '../src/driver/loop.js';
import { ArtifactStore } from '../src/report/artifacts.js';
import { ModelRouter } from '../src/router/model-router.js';
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

console.log('=== v67 PART A: buildGoalPlannerPrompt renders/omits the site map section ===');
{
  const withMap = buildGoalPlannerPrompt({
    task: 'place an order',
    url: 'http://localhost:3000/checkout',
    axText: 'heading "Checkout"',
    siteMapSummary: '- http://localhost:3000/checkout [exercised]: button "Place order"',
  });
  check('section appears with its exact title when siteMapSummary is set', withMap.includes('KNOWN SITE MAP (from a previous crawl; may be stale — trust the live page over this):'));
  check('the summary content is included', withMap.includes('button "Place order"'));

  const withoutMap = buildGoalPlannerPrompt({
    task: 'place an order',
    url: 'http://localhost:3000/checkout',
    axText: 'heading "Checkout"',
  });
  check('section is absent when siteMapSummary is omitted', !withoutMap.includes('KNOWN SITE MAP'));
}

/* ------------------------------------------------------------------------- *
 * PART B: end-to-end through runDriverLoop's goal-planning call. Same
 * hand-rolled FAKE BrowserPort + real-ModelRouter harness as v27/v66; the
 * router here supports BOTH plan-goals (brain) and plan-step (navigator) on
 * one adapter, mirroring v33.trace-spans.ts's MockAdapter pattern.
 * ------------------------------------------------------------------------- */

function fakeSnapshot(url: string): AxSnapshot {
  return { root: { id: 'root', role: 'WebArea', children: [{ id: 'n1', role: 'heading', name: 'Page' }] }, text: `heading "Page at ${url}"`, truncated: false };
}

class FakeMapBrowser implements BrowserPort {
  constructor(private readonly currentUrl: string) {}
  async launch(): Promise<void> {}
  async navigate(_url: string): Promise<void> {}
  async url(): Promise<string> {
    return this.currentUrl;
  }
  async axTree(): Promise<AxSnapshot> {
    return fakeSnapshot(this.currentUrl);
  }
  async click(): Promise<void> {}
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
    return 'tab';
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

/** Serves BOTH plan-goals (brain, first call) and plan-step (navigator,
 * second call) — discriminated by the prompt's own role banner. Captures
 * every prompt it's asked to plan from. */
function brainAndNavigator(prompts: string[]): ModelAdapter {
  return {
    name: 'fake-brain-nav',
    rung: 1,
    available: async () => true,
    supports: (c: Capability) => c === 'plan-step' || c === 'plan-goals',
    generateJson: async (req: JsonRequest) => {
      prompts.push(req.prompt);
      if (req.prompt.startsWith('You are the PLANNER')) {
        return { thought: 'one goal is enough', goals: ['confirm the page loaded'] };
      }
      return { thought: 'done', actions: [{ type: 'finish', verdict: 'fail', reason: 'stop here (no visual model)' }] };
    },
  };
}

function tmpArtifacts(): ArtifactStore {
  return new ArtifactStore(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-art-sitemap-')));
}

function writeAppModel(dir: string, baseUrl: string, generatedAt: string = new Date().toISOString()): void {
  const model: AppModel = {
    version: APP_MODEL_VERSION,
    baseUrl,
    generatedAt,
    routes: [
      {
        route: `${baseUrl}/checkout`,
        source: 'crawl',
        discoveredAt: generatedAt,
        exercised: true,
        states: [
          {
            structuralSignature: 'sig1',
            firstSeenAt: generatedAt,
            lastSeenAt: generatedAt,
            elements: [{ role: 'button', name: 'Place order', discoveredAt: generatedAt, coveredByScripts: [] }],
          },
        ],
        coveredByScripts: ['checkout.json'],
      },
    ],
  };
  saveAppModel(model, dir);
}

const origCwd = process.cwd();

async function withTempCwd<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-sitemap-cwd-'));
  process.chdir(dir);
  try {
    return await fn(dir);
  } finally {
    process.chdir(origCwd);
  }
}

console.log('\n=== v67 PART B: wiring through runDriverLoop ===');

await withTempCwd(async (dir) => {
  writeAppModel(dir, 'http://localhost:3000');
  const prompts: string[] = [];
  const router = new ModelRouter([brainAndNavigator(prompts)]);
  await runDriverLoop(new FakeMapBrowser('http://localhost:3000/checkout'), router, tmpArtifacts(), 'check the page', 'http://localhost:3000/checkout', {
    maxSteps: 4,
    allowedHosts: ['localhost'],
  });
  const plannerPrompt = prompts.find((p) => p.startsWith('You are the PLANNER'));
  check('matching host: KNOWN SITE MAP section present in the brain prompt', !!plannerPrompt?.includes('KNOWN SITE MAP'));
  check('matching host: the crawled route appears in the section', !!plannerPrompt?.includes('/checkout') && !!plannerPrompt?.includes('Place order'));
});

await withTempCwd(async (dir) => {
  writeAppModel(dir, 'http://other-app.example.com');
  const prompts: string[] = [];
  const router = new ModelRouter([brainAndNavigator(prompts)]);
  await runDriverLoop(new FakeMapBrowser('http://localhost:3000/checkout'), router, tmpArtifacts(), 'check the page', 'http://localhost:3000/checkout', {
    maxSteps: 4,
    allowedHosts: ['localhost'],
  });
  const plannerPrompt = prompts.find((p) => p.startsWith('You are the PLANNER'));
  check('host mismatch: KNOWN SITE MAP section absent', !plannerPrompt?.includes('KNOWN SITE MAP'));
});

await withTempCwd(async () => {
  // no .spike/app-model.json written at all in this tmp dir
  const prompts: string[] = [];
  const router = new ModelRouter([brainAndNavigator(prompts)]);
  await runDriverLoop(new FakeMapBrowser('http://localhost:3000/checkout'), router, tmpArtifacts(), 'check the page', 'http://localhost:3000/checkout', {
    maxSteps: 4,
    allowedHosts: ['localhost'],
  });
  const plannerPrompt = prompts.find((p) => p.startsWith('You are the PLANNER'));
  check('no app-model file: KNOWN SITE MAP section absent', !plannerPrompt?.includes('KNOWN SITE MAP'));
});

await withTempCwd(async (dir) => {
  const staleDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago
  writeAppModel(dir, 'http://localhost:3000', staleDate);
  const stalePath = path.join(dir, '.spike', 'app-model.json');
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  fs.utimesSync(stalePath, old, old); // backdate the file's own mtime — invalidation is by mtime, not the generatedAt field
  const prompts: string[] = [];
  const router = new ModelRouter([brainAndNavigator(prompts)]);
  await runDriverLoop(new FakeMapBrowser('http://localhost:3000/checkout'), router, tmpArtifacts(), 'check the page', 'http://localhost:3000/checkout', {
    maxSteps: 4,
    allowedHosts: ['localhost'],
  });
  const plannerPrompt = prompts.find((p) => p.startsWith('You are the PLANNER'));
  check('stale (30-day-old) app-model file: KNOWN SITE MAP section absent', !plannerPrompt?.includes('KNOWN SITE MAP'));
});

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v67 checks passed`);
process.exit(failed.length ? 1 : 0);
