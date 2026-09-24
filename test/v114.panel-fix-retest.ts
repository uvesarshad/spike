/* v114 — A6: the panel's auto-fix re-tests. vibe.fix runs the same loop as the
 * CLI (dispatch -> wait -> re-run) and reports the new verdict in vibe.fix-done.
 * Stub agent + stub run, in-memory bridge; scratch HOME (never real settings). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};
const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-v114-'));
const projectDir = path.join(scratch, 'project');
fs.mkdirSync(projectDir, { recursive: true });
process.env.HOME = path.join(scratch, 'home');
process.env.LOCALAPPDATA = path.join(scratch, 'home');
process.env.SPIKE_FIX_AGENT_CWD = projectDir;

const { VibeService } = await import('../src/vibe/service.js');
type BridgeServerT = import('../src/bridge/bridge-server.js').BridgeServer;
type ReportT = import('../src/report/report.js').Report;
type Handler = (params: unknown, ctx: { clientId: number }) => Promise<unknown>;

class FakeBridge {
  private handlers = new Map<string, Handler>();
  readonly events: { event: string; params: Record<string, unknown> }[] = [];
  onRequest(m: string, h: Handler) { this.handlers.set(m, h); }
  onEvent() {}
  offEvent() {}
  sendEvent(event: string, params: Record<string, unknown>) { this.events.push({ event, params }); }
  isAuthenticated() { return true; }
  call() { return Promise.resolve({ ok: true }); }
  async request(m: string, p: unknown = {}) { return this.handlers.get(m)!(p, { clientId: 1 }); }
}

const rep = (verdict: 'pass' | 'fail' | 'uncertain'): ReportT =>
  ({ runId: 'v114', task: 'place an order', url: 'http://localhost:9401/', verdict, reason: verdict, steps: [], model_trace: [], evidence_paths: [] }) as unknown as ReportT;

async function fixDone(b: FakeBridge) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !b.events.some((e) => e.event === 'vibe.fix-done')) await new Promise((r) => setTimeout(r, 20));
  return b.events.find((e) => e.event === 'vibe.fix-done')?.params;
}

function setup(verdict: 'fail' | 'uncertain', runVerdicts: ('pass' | 'fail')[]) {
  const bridge = new FakeBridge();
  const service = new VibeService(bridge as unknown as BridgeServerT);
  service.start();
  service.noteFailedReportForTest(rep(verdict));
  let dispatches = 0;
  let runs = 0;
  service.noteRerunForTest('place an order', 'http://localhost:9401/', {
    dispatchFn: async () => { dispatches++; return { ok: true, agent: 'stub' }; },
    runFn: (async () => rep(runVerdicts[Math.min(runs++, runVerdicts.length - 1)])) as never,
    rebuild: { graceMs: 0 },
  });
  return { bridge, dispatches: () => dispatches, runs: () => runs };
}

// pass on the re-test => verdict pass, attempts 2
{
  const s = setup('fail', ['pass']);
  const r = (await s.bridge.request('vibe.fix', { confirmed: true })) as { accepted?: boolean };
  check('accepted', r.accepted === true);
  const done = await fixDone(s.bridge);
  check('fix-done carries verdict pass and attempts 2', done?.verdict === 'pass' && done?.attempts === 2 && done?.ok === true);
  check('agent dispatched once, run once', s.dispatches() === 1 && s.runs() === 1);
}

// never passes => still failing, capped by maxFixAttempts
{
  const s = setup('fail', ['fail']);
  await s.bridge.request('vibe.fix', { confirmed: true, maxFixAttempts: 3 });
  const done = await fixDone(s.bridge);
  check('still failing after the cap', done?.verdict === 'fail' && done?.attempts === 3 && s.dispatches() === 2);
}

// an uncertain result is not fixed
{
  const s = setup('uncertain', ['pass']);
  let err = '';
  await s.bridge.request('vibe.fix', { confirmed: true }).catch((e: Error) => { err = e.message; });
  check('uncertain result: vibe.fix refuses, nothing dispatched', err.includes('not a confirmed failure') && s.dispatches() === 0);
}

// panel wording
{
  const panel = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'panel.js'), 'utf8');
  check('panel says "Fixed and re-checked: passed"', panel.includes('Fixed and re-checked: passed'));
  check('panel says "Still failing after N tries"', panel.includes('Still failing after'));
  check('panel hides auto-fix unless the verdict is fail', panel.includes("(verdict !== 'fail') || debugMode !== 'auto'"));
}

fs.rmSync(scratch, { recursive: true, force: true });
if (checks.some(([, ok]) => !ok)) process.exit(1);
process.exit(0);
