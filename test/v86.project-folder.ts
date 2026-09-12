/* V86 — auto-fix knows WHICH project it is allowed to edit, and hides itself
 * when there is nothing to edit with (A11, P0, second half).
 *
 * Two problems, both of which made the panel's auto-fix button unfit for the
 * people it is aimed at:
 *
 *   1. No project folder existed anywhere in the UI, and dispatchFix quietly
 *      fell back to process.cwd(). For a helper that auto-starts at login that
 *      is whatever directory it happened to inherit — so a coding agent was
 *      pointed at the wrong repo (or at nothing) with no way for the user to
 *      say otherwise. It now REFUSES with a plain message unless a project
 *      folder is configured; only the command line supplies a fallback, where
 *      the directory the command was typed in is an explicit choice.
 *
 *   2. Auto-fix was offered even with no coding agent installed, so the button
 *      could only ever fail. vibe.config.get now reports fixAgentAvailable and
 *      the panel hides the button and the Settings toggle outright, leaving the
 *      copy-the-prompt path.
 *
 * No real BridgeServer/socket (see v7/v9 for those) — the in-memory FakeBridge
 * shape from v65/v85, a scratch HOME so the running user's real settings are
 * untouched, and a harmless `node -e` stood in for the coding agent so the
 * "configured folder" path can be exercised with no chance of a real agent
 * being spawned against this repo.
 *
 * Covers:
 *   1. dispatchFix refuses, with the plain message, when no project folder is set
 *   2. it refuses BEFORE resolving/spawning any agent
 *   3. the command line's own working directory still serves as the fallback
 *   4. a configured project folder is what the agent actually runs in
 *   5. vibe.fix answers needsProjectFolder rather than dispatching
 *   6. vibe.config.get carries fixAgentCwd + a fixAgentAvailable boolean
 *   7. vibe.config.set persists the folder, and a blank value clears it
 *   8. the wiring: the panel's Project folder field is helper-only, the auto-fix
 *      button/toggle disappear when no coding agent was found, and the exact
 *      replacement sentence is shown
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

// ---- isolate per-machine state BEFORE importing (see v85) ------------------
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-v86-'));
const projectDir = path.join(scratch, 'project');
const cliDir = path.join(scratch, 'cli-cwd');
fs.mkdirSync(projectDir, { recursive: true });
fs.mkdirSync(cliDir, { recursive: true });
process.env.HOME = path.join(scratch, 'home');
process.env.LOCALAPPDATA = path.join(scratch, 'home');
delete process.env.SPIKE_FIX_AGENT_CWD;
// a "coding agent" that writes a marker naming the directory it ran in
const marker = 'ran-here.txt';
process.env.SPIKE_FIX_AGENT_BIN = process.execPath;
process.env.SPIKE_FIX_AGENT_ARGS = JSON.stringify([
  '-e',
  `require('fs').writeFileSync('${marker}', process.cwd())`,
]);

const { VibeService } = await import('../src/vibe/service.js');
const { dispatchFix, NO_PROJECT_FOLDER_MESSAGE } = await import('../src/vibe/auto-fix.js');
const { SettingsStore } = await import('../src/vibe/settings.js');
type BridgeServerT = import('../src/bridge/bridge-server.js').BridgeServer;
type ReportT = import('../src/report/report.js').Report;

type Handler = (params: unknown, ctx: { clientId: number }) => Promise<unknown>;

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

function failedReport(): ReportT {
  return {
    runId: 'v86',
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

// ---- 1/2: no project folder → refuse, before touching any agent ------------
{
  let message = '';
  try {
    await dispatchFix(failedReport(), { onProgress: () => {} });
    message = '(did not throw)';
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  check('an unconfigured project folder refuses the fix', message === NO_PROJECT_FOLDER_MESSAGE);
  check(
    'the refusal says what to do, in plain words',
    /project folder/i.test(message) && /Settings/.test(message) && !/cwd|env|SPIKE_/i.test(message),
  );
  check('nothing was run anywhere', !fs.existsSync(path.join(cliDir, marker)));
}

// ---- 3: the command line's working directory is still a valid choice -------
{
  const res = await dispatchFix(failedReport(), {
    onProgress: () => {},
    defaultCwd: cliDir,
    yesAutoFix: true,
  });
  check('the command line can supply its own working directory', res.ok === true);
  const ran = fs.existsSync(path.join(cliDir, marker)) ? fs.readFileSync(path.join(cliDir, marker), 'utf8') : '';
  check('the agent ran in that directory', fs.realpathSync(ran || '/') === fs.realpathSync(cliDir));
}

// ---- 5: the panel path answers with the question instead of dispatching ----
{
  const bridge = makeService();
  const reply = (await bridge.request('vibe.fix', {})) as { needsProjectFolder?: boolean; message?: string; accepted?: boolean };
  check('vibe.fix reports the missing project folder', reply.needsProjectFolder === true);
  check('…and does not claim to have started', reply.accepted !== true);
  check('…and carries the plain message', reply.message === NO_PROJECT_FOLDER_MESSAGE);
  check('…and never falls back to the helper\'s own directory', !fs.existsSync(path.join(process.cwd(), marker)));
}

// ---- 6/7: the folder round-trips through the panel's settings channel ------
{
  const bridge = makeService();
  const before = (await bridge.request('vibe.config.get')) as { fixAgentCwd?: string; fixAgentAvailable?: boolean };
  check('config carries an (empty) project folder', before.fixAgentCwd === '');
  check('config says whether a coding agent is installed', typeof before.fixAgentAvailable === 'boolean');

  await bridge.request('vibe.config.set', { fixAgentCwd: `  ${projectDir}  ` });
  const after = (await bridge.request('vibe.config.get')) as { fixAgentCwd?: string };
  check('the chosen project folder is saved (trimmed)', after.fixAgentCwd === projectDir);
  check('it reaches the on-disk settings', new SettingsStore().read().fixAgentCwd === projectDir);

  // ---- 4: and it is where the agent actually runs
  const dispatched = (await bridge.request('vibe.fix', { confirmed: true })) as { accepted?: boolean };
  check('a configured folder lets the panel fix dispatch', dispatched.accepted === true);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !bridge.events.some((e) => e.event === 'vibe.fix-done')) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const ranIn = fs.existsSync(path.join(projectDir, marker))
    ? fs.readFileSync(path.join(projectDir, marker), 'utf8')
    : '';
  check(
    'the agent edits the chosen project, nowhere else',
    Boolean(ranIn) && fs.realpathSync(ranIn) === fs.realpathSync(projectDir),
  );

  await bridge.request('vibe.config.set', { fixAgentCwd: '   ' });
  const cleared = (await bridge.request('vibe.config.get')) as { fixAgentCwd?: string };
  check('a blank value clears the project folder', cleared.fixAgentCwd === '');
}

// ---- 8: the wiring, read off the shipped sources ---------------------------
{
  const panelSrc = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'panel.js'), 'utf8');
  const panelHtml = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'panel.html'), 'utf8');
  const swSrc = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'sw.js'), 'utf8');

  check('Settings has a Project folder field', panelHtml.includes('id="setProjectFolder"') && panelHtml.includes('Project folder'));
  check(
    'the field is shown only while the desktop helper is connected',
    /setProjectFolderRow\.hidden = !bridgeHealthy\(\)/.test(panelSrc),
  );
  check('saving sends the folder', /fixAgentCwd: setProjectFolder/.test(panelSrc));
  check('the worker relays the missing-folder answer', swSrc.includes('needsProjectFolder'));
  check(
    'the panel has the exact no-coding-agent sentence',
    panelSrc.includes(
      'Auto-fix needs a coding agent installed on this computer (Claude Code, Codex or Gemini CLI). ',
    ) && panelSrc.includes('You can still copy the fix prompt.'),
  );
  check('the panel reads fixAgentAvailable', /currentConfig\.fixAgentAvailable/.test(panelSrc));
  check(
    'no coding agent hides the auto-fix toggle and the button',
    /setAutoFixRow\.hidden = true/.test(panelSrc) && /autoFixBtn\.hidden = true/.test(panelSrc),
  );
  // §1.5 vocabulary: nothing user-facing here may name the plumbing.
  const strings = [
    NO_PROJECT_FOLDER_MESSAGE,
    'Auto-fix needs a coding agent installed on this computer (Claude Code, Codex or Gemini CLI). You can still copy the fix prompt.',
  ].join(' ');
  check('the new copy avoids jargon', !/daemon|bridge|CDP|BYOK|SPIKE_|cwd|env var/i.test(strings));
}

try {
  fs.rmSync(scratch, { recursive: true, force: true });
} catch { /* best effort */ }

const failed = checks.filter(([, ok]) => !ok);
console.log(`\nv86: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) {
  console.error('FAILED: ' + failed.map(([l]) => l).join(', '));
  process.exit(1);
}
