/* v20 — real token accounting. No Chrome, no AI: fake adapters carry canned
 * lastUsage values, driven through ModelRouter + a fake BrowserPort runDriverLoop
 * (harness style copied from v13). Asserts:
 *  1. the router copies adapter.lastUsage into each ModelTraceEntry.usage;
 *  2. report.tokens sums cheapModelTotal / cheapModelCached over the trace;
 *  3. callsByRung counts every model call by rung;
 *  4. verdictPayloadTokens == ceil(slim-report chars / 4) and == tokenEstimate;
 *  5. an adapter with no lastUsage leaves usage undefined (rung-0/local case).
 *
 * Run: npx tsx test/v20.tokens.ts   (exits nonzero on any failed check)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDriverLoop } from '../src/driver/loop.js';
import { ArtifactStore } from '../src/report/artifacts.js';
import { ModelRouter } from '../src/router/model-router.js';
import { slimReport } from '../src/report/report.js';
import type { AdapterUsage, Capability, JsonRequest, ModelAdapter } from '../src/router/adapter.js';
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

/* ===================== fake harness (mirrors v13) ===================== */

function fakeTree(): AxNode {
  return {
    id: 'root',
    role: 'WebArea',
    children: [{ id: 'n2', role: 'button', name: 'Sign in' }],
  };
}
function fakeSnapshot(): AxSnapshot {
  return { root: fakeTree(), text: 'button "Sign in" n2', truncated: false };
}

class FakeBrowser implements BrowserPort {
  clicked: string[] = [];
  constructor(public currentUrl: string) {}
  async launch(): Promise<void> {}
  async navigate(url: string): Promise<void> {
    this.currentUrl = url;
  }
  async url(): Promise<string> {
    return this.currentUrl;
  }
  async axTree(): Promise<AxSnapshot> {
    return fakeSnapshot();
  }
  async click(nodeId: string): Promise<void> {
    this.clicked.push(nodeId);
  }
  async type(): Promise<void> {}
  async hover(): Promise<void> {}
  async pressKey(): Promise<void> {}
  async selectOption(): Promise<void> {}
  async reload(): Promise<void> {}
  async goBack(): Promise<void> {}
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

/** A scripted planner that returns the queued plan and exposes a canned
 * per-call lastUsage (set BEFORE each generateJson resolves, so the router can
 * read it right after — exactly how the real adapters behave). usages[i] is the
 * usage for the i-th call; undefined leaves lastUsage unset for that call. */
function scriptedPlanner(
  plans: unknown[],
  usages: (AdapterUsage | undefined)[],
  rung: 0 | 1 | 2 | 3 = 1,
): ModelAdapter {
  let i = 0;
  const adapter: ModelAdapter = {
    name: `fake-planner-r${rung}`,
    rung,
    lastUsage: undefined,
    available: async () => true,
    supports: (c: Capability) => c === 'plan-step',
    generateJson: async (_req: JsonRequest) => {
      adapter.lastUsage = usages[Math.min(i, usages.length - 1)];
      const p = plans[Math.min(i, plans.length - 1)];
      i++;
      return p;
    },
  };
  return adapter;
}

function tmpArtifacts(): ArtifactStore {
  return new ArtifactStore(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-art-v20-')));
}

/* ===================== 1) router copies usage into the trace ===================== */
console.log('=== v20 1/2: usage flows adapter → trace → report.tokens ===');
{
  const browser = new FakeBrowser('http://localhost:3000/');
  // two planner calls: one click batch, then a finish:fail (no visual model needed).
  const planner = scriptedPlanner(
    [
      { thought: 'click sign in', actions: [{ type: 'click', nodeId: 'n2' }] },
      { thought: 'done', actions: [{ type: 'finish', verdict: 'fail', reason: 'stop (no visual model)' }] },
    ],
    [
      { promptTokens: 1200, outputTokens: 40, totalTokens: 1240, cachedTokens: 800 },
      { promptTokens: 1500, outputTokens: 30, totalTokens: 1530, cachedTokens: 1000 },
    ],
    1,
  );
  const router = new ModelRouter([planner]);
  const report = await runDriverLoop(browser, router, tmpArtifacts(), 'sign in', 'http://localhost:3000/', {
    maxSteps: 6,
    allowedHosts: ['localhost'],
  });

  const planTrace = report.model_trace.filter((t) => t.capability === 'plan-step');
  check('two plan-step trace entries recorded', planTrace.length === 2);
  check('trace entry 1 carries usage.totalTokens 1240', planTrace[0]?.usage?.totalTokens === 1240);
  check('trace entry 2 carries usage.totalTokens 1530', planTrace[1]?.usage?.totalTokens === 1530);

  check('report.tokens present', report.tokens !== undefined);
  check('cheapModelTotal = 1240 + 1530 = 2770', report.tokens?.cheapModelTotal === 2770);
  check('cheapModelCached = 800 + 1000 = 1800', report.tokens?.cheapModelCached === 1800);
  check('callsByRung counts 2 rung-1 calls', report.tokens?.callsByRung[1] === 2);

  // verdictPayloadTokens == ceil(slim JSON chars / 4), and == tokenEstimate
  const expectPayload = Math.ceil(JSON.stringify(slimReport(report)).length / 4);
  check('verdictPayloadTokens == ceil(slim chars / 4)', report.tokens?.verdictPayloadTokens === expectPayload);
  check('tokenEstimate == verdictPayloadTokens', report.tokenEstimate === report.tokens?.verdictPayloadTokens);
  check('verdictPayloadTokens is sane (small, > 0, < 2000)', expectPayload > 0 && expectPayload < 2000);
  check(
    'verdictPayloadTokens (caller pays) << cheapModelTotal (looking spend)',
    (report.tokens?.verdictPayloadTokens ?? Infinity) < (report.tokens?.cheapModelTotal ?? 0),
  );
}

/* ===================== 2) no-usage adapter leaves usage undefined ===================== */
console.log('\n=== v20 2/2: a local/rung-0 adapter without counts leaves usage undefined ===');
{
  const browser = new FakeBrowser('http://localhost:3000/');
  // A rung-0-style planner that reports NO usage on either call (mirrors the
  // on-device / Ollama case: it does the work but surfaces no token counts).
  // The router always picks the lowest available rung, so this adapter answers
  // every plan-step call — both trace entries must carry usage === undefined.
  const noUsage = scriptedPlanner(
    [
      { thought: 'click', actions: [{ type: 'click', nodeId: 'n2' }] },
      { thought: 'done', actions: [{ type: 'finish', verdict: 'fail', reason: 'stop' }] },
    ],
    [undefined, undefined],
    0,
  );
  const router = new ModelRouter([noUsage]);
  const report = await runDriverLoop(browser, router, tmpArtifacts(), 'x', 'http://localhost:3000/', {
    maxSteps: 6,
    allowedHosts: ['localhost'],
  });

  const planTrace = report.model_trace.filter((t) => t.capability === 'plan-step');
  check('two rung-0 plan-step entries recorded', planTrace.length === 2 && planTrace.every((t) => t.rung === 0));
  check('every rung-0 entry has usage undefined', planTrace.every((t) => t.usage === undefined));
  check('cheapModelTotal is 0 (no counts to sum)', report.tokens?.cheapModelTotal === 0);
  check('cheapModelCached is 0', report.tokens?.cheapModelCached === 0);
  check('callsByRung counts 2 rung-0 calls', report.tokens?.callsByRung[0] === 2);
  // even with $0 looking, the caller still pays for the verdict payload
  check('verdictPayloadTokens still > 0 (caller reads the verdict)', (report.tokens?.verdictPayloadTokens ?? 0) > 0);
}

/* ===================== summary ===================== */
const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v20 checks passed`);
process.exit(failed.length ? 1 : 0);
