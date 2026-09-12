/**
 * V83 — A12 (P0): replay actually resolves vaulted secrets, and a missing one
 * is a loud, distinct failure — never a silent fall-through to a paid AI run.
 *
 * Before this fix: `ReplayOptions.vault` existed but neither `engine.ts` call
 * site passed one, AND (a deeper gap the audit's evidence didn't spell out)
 * the recorded `type` step's {{secret:NAME}} placeholder was never resolved
 * at all — only a `script` step's nested executor honoured `opts.vault`. A
 * recorded login typed the literal `{{secret:PASSWORD}}` text, so every
 * credentialed regression test failed, and qaRun's replay-fallback silently
 * retried it as a full paid AI run (the "my free tests always cost money"
 * symptom).
 *
 * This suite is pure/in-memory: a fake BrowserPort (a single textbox, no
 * CDP/Chrome) drives `replayScript` directly.
 *   1. with a vault holding PASSWORD, the {{secret:PASSWORD}} placeholder
 *      resolves to the real value before it's typed, and the replay passes.
 *   2. without the secret (no vault, or a vault missing it), the replay FAILS
 *      with a reason naming the secret and the exact remediation command, and
 *      `isMissingSecretFailure()` recognizes it.
 *   3. a locator/UI-drift failure (nothing to do with secrets) is NOT
 *      recognized as a missing-secret failure — the predicate doesn't over-fire.
 *   4. a static source check on engine.ts confirms qaRun's replay-fallback
 *      branch returns EARLY on a missing-secret failure, before it ever
 *      reaches `runFreshAiPass` (the "no silent AI fallback" requirement) —
 *      exercising that branch live needs a real Chrome session (openSession),
 *      which is out of scope for the fast suite; see test/e2e.recorder.ts
 *      (browser bucket) for the live pre-run-matcher path this guards.
 *
 * Run: npx tsx test/v83.replay-secrets.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayScript, isMissingSecretFailure, MissingSecretError } from '../src/recorder/replay.js';
import { ArtifactStore } from '../src/report/artifacts.js';
import type { QaScript } from '../src/recorder/script.js';
import type { Report } from '../src/report/report.js';
import { createRunDataState } from '../src/run-data/index.js';
import type { AxNode, AxSnapshot, BrowserPort, ConsoleEntry, NetworkEntry } from '../src/ports/browser-port.js';

let failures = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => console.log(`PASS ${name}`),
      (e) => {
        failures++;
        console.error(`FAIL ${name}: ${e instanceof Error ? e.message : e}`);
      },
    );
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-v83-'));

/** A single-textbox page — just enough for a `type` step to resolve and run. */
class LoginPage implements BrowserPort {
  readonly typed: string[] = [];
  private currentUrl = 'about:blank';

  async launch(): Promise<void> {}
  async navigate(u: string): Promise<void> {
    this.currentUrl = u;
  }
  async url(): Promise<string> {
    return this.currentUrl;
  }
  async axTree(): Promise<AxSnapshot> {
    const root: AxNode = {
      id: 'root',
      role: 'document',
      name: 'Login',
      children: [{ id: 'n1', role: 'textbox', name: 'Password' }],
    };
    return { root, text: 'document "Login"\n  textbox "Password"', truncated: false };
  }
  async click(): Promise<void> {}
  async type(_nodeId: string, text: string): Promise<void> {
    this.typed.push(text);
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

const loginScript: QaScript = {
  version: 1,
  name: 'v83-login',
  task: 'log in',
  url: 'http://localhost/login',
  sourceRunId: 'r',
  createdAt: '2026-01-01T00:00:00.000Z',
  steps: [
    { type: 'navigate', url: 'http://localhost/login' },
    { type: 'type', target: { role: 'textbox', name: 'Password' }, text: '{{secret:PASSWORD}}' },
  ],
};

console.log('=== v83 1/4: a vault holding the secret resolves the placeholder and passes ===');
await check('replay with vault: passes and types the REAL value, not the placeholder', async () => {
  const browser = new LoginPage();
  const vault = { get: (name: string) => (name === 'PASSWORD' ? 's3cr3t-value' : undefined) };
  const report = await replayScript(browser, null, new ArtifactStore(path.join(root, 'ok')), loginScript, { vault });
  assert.equal(report.verdict, 'pass');
  assert.deepEqual(browser.typed, ['s3cr3t-value']);
  assert.equal(isMissingSecretFailure(report), false);
});

console.log('\n=== v83 2/4: no vault at all -> loud, named failure ===');
await check('replay with NO vault: fails naming the secret + the fix command, never typed the placeholder as-is silently', async () => {
  const browser = new LoginPage();
  const report = await replayScript(browser, null, new ArtifactStore(path.join(root, 'no-vault')), loginScript, {});
  assert.equal(report.verdict, 'fail');
  assert.match(report.reason, /missing secret PASSWORD — run: spike secret set PASSWORD/);
  assert.equal(browser.typed.length, 0, 'never called browser.type() with the unresolved placeholder');
  assert.equal(isMissingSecretFailure(report), true);
});

await check('replay with a vault that lacks the secret: same loud failure', async () => {
  const browser = new LoginPage();
  const vault = { get: () => undefined };
  const report = await replayScript(browser, null, new ArtifactStore(path.join(root, 'empty-vault')), loginScript, { vault });
  assert.equal(report.verdict, 'fail');
  assert.match(report.reason, /missing secret PASSWORD — run: spike secret set PASSWORD/);
  assert.equal(isMissingSecretFailure(report), true);
});

console.log('\n=== v83 3/4: isMissingSecretFailure does not over-fire on an unrelated replay failure ===');
await check('a plain UI-drift / locator failure is NOT classified as a missing-secret failure', () => {
  const uiDriftReport: Report = {
    verdict: 'fail' as const,
    failing_step: { index: 0, action: { type: 'click' as const, nodeId: 'x' }, description: 'click button "Submit"' },
    console_error: null,
    evidence_paths: [],
    reason: 'replay failed at step 1 (click button "Submit"): UI drift: no button "Submit" on the page after 5000ms',
    runId: 'r1',
    task: 't',
    url: 'http://x/',
    steps: [
      {
        index: 0,
        action: { type: 'click' as const, nodeId: 'x' },
        description: 'click button "Submit"',
        ok: false,
        error: 'UI drift: no button "Submit" on the page after 5000ms',
        console: [],
        network: [],
        ts: 0,
      },
    ],
    model_trace: [],
    run_data: createRunDataState(),
    durationMs: 1,
    tokenEstimate: 0,
  };
  assert.equal(isMissingSecretFailure(uiDriftReport), false);
});

await check('MissingSecretError carries the secret name and the exact remediation message', () => {
  const e = new MissingSecretError('PASSWORD');
  assert.equal(e.secretName, 'PASSWORD');
  assert.equal(e.message, 'missing secret PASSWORD — run: spike secret set PASSWORD');
});

console.log('\n=== v83 4/4: qaRun never falls back to a paid AI run on a missing-secret replay failure ===');
await check('engine.ts: both replayScript call sites pass the vault', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'src', 'engine.ts'), 'utf8');
  const calls = src.match(/replayScript\(session\.browser, session\.nano, artifacts, script, \{[^}]*\}\)/g) ?? [];
  assert.equal(calls.length, 2, 'expected exactly two replayScript(...) call sites in qaReplay');
  for (const call of calls) assert.match(call, /\bvault\b/, `call site is missing the vault: ${call}`);
});

await check('engine.ts: qaRun returns EARLY on isMissingSecretFailure, before the generic replay-fallback path', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'src', 'engine.ts'), 'utf8');
  const gateIdx = src.indexOf('if (isMissingSecretFailure(replayed))');
  const fallbackIdx = src.indexOf("progress('matched replay failed — falling back to a fresh AI run')");
  const aiPassIdx = src.indexOf('const result = await runFreshAiPass(task, url, opts, progress, runSpan);');
  assert.ok(gateIdx > -1, 'isMissingSecretFailure gate not found in qaRun');
  assert.ok(fallbackIdx > -1 && aiPassIdx > -1, 'generic fallback / AI-pass call not found');
  assert.ok(gateIdx < fallbackIdx, 'the missing-secret gate must be checked BEFORE the generic fallback path');
  assert.ok(fallbackIdx < aiPassIdx, 'the generic fallback path precedes the actual AI pass, as expected');
  // The gated branch must `return` (not just set a flag) so it never reaches runFreshAiPass.
  const gateBlock = src.slice(gateIdx, fallbackIdx);
  assert.match(gateBlock, /\breturn result;/, 'the missing-secret branch must return early');
});

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
