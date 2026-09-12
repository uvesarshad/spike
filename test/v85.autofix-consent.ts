/* V85 — auto-fix from the side panel can actually pass its own consent gate (A11, P0).
 *
 * Handing a failed run to a coding agent lets that agent edit files on disk with
 * nobody reviewing the diff first, so the first such fix per project directory
 * needs an explicit human yes. That gate (ensureAutoFixConfirmed) previously had
 * only two ways to answer: a y/N prompt on the helper's own terminal, or a
 * `confirmed:true` flag nothing ever sent. The side panel sent neither — so the
 * panel's auto-fix button either failed with a message about a command-line flag
 * the user can't reach, or, in a real terminal, hung forever waiting on a
 * keypress nobody could see.
 *
 * Now the question is answered as DATA: `vibe.fix` with no `confirmed` and no
 * prior acceptance returns {needsConfirmation:true, projectDir}; the panel shows
 * its own dialog and re-sends with confirmed:true; acceptance is remembered per
 * project directory so it asks at most once.
 *
 * No real BridgeServer/socket (that belongs in the browser bucket — see v7/v9):
 * the same in-memory FakeBridge shape as v65.vibe-map-coverage.ts. The settings
 * store is redirected at a scratch HOME so the running user's real settings (and
 * their real accepted-directory list) are never touched, and the fix agent is
 * pinned to a harmless `node -e` in a scratch directory so a "confirmed" path
 * can be exercised without any chance of a real coding agent being spawned
 * against this repo.
 *
 * Covers:
 *   1. an unconfirmed bridge fix returns needsConfirmation — it does not throw,
 *      and it does not try to prompt a terminal that isn't there
 *   2. the reply names the project folder, so the panel can put it in the dialog
 *   3. an unconfirmed call leaves the service idle (a second one still asks)
 *   4. confirmed:true is accepted and dispatches
 *   5. acceptance is remembered: the NEXT unconfirmed call for the same project
 *      goes straight through
 *   6. the wiring: the bridge path forces the non-interactive branch of the gate,
 *      the worker relays needsConfirmation to the panel, and the panel asks with
 *      the agreed wording before re-sending confirmed:true
 */

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

// ---- isolate every piece of per-machine state BEFORE importing the modules --
// (SettingsStore resolves its path from LOCALAPPDATA/HOME at construction time,
// and loadConfig reads the SPIKE_* env on every call.)
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-v85-'));
const projectDir = path.join(scratch, 'project');
fs.mkdirSync(projectDir, { recursive: true });
process.env.HOME = path.join(scratch, 'home');
process.env.LOCALAPPDATA = path.join(scratch, 'home');
process.env.SPIKE_FIX_AGENT_CWD = projectDir;
// a "coding agent" that exits 0 immediately and edits nothing
process.env.SPIKE_FIX_AGENT_BIN = process.execPath;
process.env.SPIKE_FIX_AGENT_ARGS = JSON.stringify(['-e', 'process.exit(0)']);

const { VibeService } = await import('../src/vibe/service.js');
const { isAutoFixAcceptedFor } = await import('../src/vibe/auto-fix.js');
type BridgeServerT = import('../src/bridge/bridge-server.js').BridgeServer;
type ReportT = import('../src/report/report.js').Report;

type Handler = (params: unknown, ctx: { clientId: number }) => Promise<unknown>;

/** Minimal stand-in for BridgeServer's public surface (see v65). */
class FakeBridge {
  private requestHandlers = new Map<string, Handler>();
  readonly events: { event: string; params: unknown }[] = [];
  onRequest(method: string, handler: Handler): void {
    this.requestHandlers.set(method, handler);
  }
  onEvent(): void {}
  offEvent(): void {}
  sendEvent(event: string, params: unknown): void {
    this.events.push({ event, params });
  }
  isAuthenticated(): boolean {
    return true;
  }
  call(): Promise<unknown> {
    return Promise.resolve({ ok: true });
  }
  async request(method: string, params: unknown = {}): Promise<unknown> {
    const h = this.requestHandlers.get(method);
    if (!h) throw new Error(`no handler registered for ${method}`);
    return h(params, { clientId: 1 });
  }
}

/** A minimal failed Report — enough for buildFixPrompt to produce something. */
function failedReport(): ReportT {
  return {
    runId: 'v85',
    task: 'place an order',
    url: 'http://localhost:9401/',
    verdict: 'fail',
    reason: 'Place order threw',
    steps: [],
    model_trace: [],
    evidence_paths: [],
    console_error: "TypeError: Cannot read properties of undefined (reading 'total')",
  } as unknown as ReportT;
}

function makeService(): FakeBridge {
  const bridge = new FakeBridge();
  const service = new VibeService(bridge as unknown as BridgeServerT);
  service.start();
  service.noteFailedReportForTest(failedReport());
  return bridge;
}

/** The whole point of the finding: this must RESOLVE, quickly, with an answer —
 * never throw, and never sit on a terminal prompt. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'TIMED-OUT'> {
  let timer: NodeJS.Timeout;
  const guard = new Promise<'TIMED-OUT'>((resolve) => {
    timer = setTimeout(() => resolve('TIMED-OUT'), ms);
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    clearTimeout(timer!);
  }
}

// ---- 1/2/3: an unconfirmed bridge fix asks, and stays idle ------------------
{
  const bridge = makeService();
  let threw: unknown;
  const res = await withTimeout(
    bridge.request('vibe.fix', {}).catch((e) => {
      threw = e;
      return undefined;
    }),
    5_000,
  );
  check('unconfirmed vibe.fix answers instead of hanging on a prompt', res !== 'TIMED-OUT');
  check('unconfirmed vibe.fix does not throw', threw === undefined);
  const reply = (res === 'TIMED-OUT' ? {} : res) as { needsConfirmation?: boolean; projectDir?: string; accepted?: boolean };
  check('unconfirmed vibe.fix returns needsConfirmation', reply.needsConfirmation === true);
  check('unconfirmed vibe.fix does not report accepted', reply.accepted !== true);
  check('the reply names the project folder for the dialog', reply.projectDir === projectDir);
  check('nothing was accepted on disk yet', isAutoFixAcceptedFor(projectDir) === false);

  // idle, so asking again still asks (rather than "a fix is already in progress")
  const again = (await bridge.request('vibe.fix', {})) as { needsConfirmation?: boolean };
  check('a declined/ignored ask leaves the service idle', again.needsConfirmation === true);
}

// ---- 4/5: confirmed goes through, and is remembered per project -------------
{
  const bridge = makeService();
  const accepted = (await bridge.request('vibe.fix', { confirmed: true })) as { accepted?: boolean };
  check('confirmed:true is accepted', accepted.accepted === true);

  // the dispatch is fire-and-forget; wait for its fix-done event so the
  // acceptance write (inside the gate) has certainly landed.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !bridge.events.some((e) => e.event === 'vibe.fix-done')) {
    await new Promise((r) => setTimeout(r, 50));
  }
  check('the confirmed fix actually dispatched', bridge.events.some((e) => e.event === 'vibe.fix-done'));
  check('acceptance is remembered for this project', isAutoFixAcceptedFor(projectDir) === true);

  const bridge2 = makeService();
  const second = (await bridge2.request('vibe.fix', {})) as { accepted?: boolean; needsConfirmation?: boolean };
  check('an accepted project is never asked again', second.accepted === true && second.needsConfirmation !== true);
}

// ---- 6: the wiring, read off the shipped sources ----------------------------
{
  const serviceSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'vibe', 'service.ts'), 'utf8');
  const swSrc = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'sw.js'), 'utf8');
  const panelSrc = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'panel.js'), 'utf8');
  const panelHtml = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'panel.html'), 'utf8');

  check(
    'the bridge dispatch forces the non-interactive branch of the gate',
    /interactive:\s*false/.test(serviceSrc),
  );
  check(
    'the worker forwards the confirmation flag',
    /sendRequest\('vibe\.fix',[^)]*confirmed/.test(swSrc),
  );
  check(
    'the worker relays needsConfirmation to the panel',
    swSrc.includes('needsConfirmation') && swSrc.includes("kind: 'fix-confirm'"),
  );
  check('the panel handles fix-confirm', panelSrc.includes("case 'fix-confirm'"));
  check(
    'the panel asks with the agreed wording',
    panelSrc.includes('Spike will let your coding agent edit files in'),
  );
  check(
    'accepting re-sends the request as confirmed',
    /startFix\(true\)/.test(panelSrc) && /kind:\s*'fix',\s*confirmed:\s*true/.test(panelSrc),
  );
  check('the confirm dialog exists in the panel markup', panelHtml.includes('id="confirmModal"'));
}

try {
  fs.rmSync(scratch, { recursive: true, force: true });
} catch { /* best effort */ }

const failed = checks.filter(([, ok]) => !ok);
console.log(`\nv85: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) {
  console.error('FAILED: ' + failed.map(([l]) => l).join(', '));
  process.exit(1);
}
