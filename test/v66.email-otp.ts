/* v66 - wait_for_email driver action (email/OTP module wiring).
 *
 * Wires src/email/'s EmailProvider interface + FakeLocalEmailProvider into
 * driver/loop.ts's action executor: `wait_for_email` polls the injected
 * provider until a matching message arrives, then (with `extractOtpTo` set)
 * runs findOtp() and stores the result via the SAME recordExtraction()
 * mechanism `extract` already uses. Same hand-rolled FAKE BrowserPort +
 * real-ModelRouter harness as v13.tier4.ts/v27.run-data.ts/v32.script-runner.ts.
 *
 * Run: npx tsx test/v66.email-otp.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeLocalEmailProvider } from '../src/email/index.js';
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

function fakeTree(): AxNode {
  return {
    id: 'root',
    role: 'WebArea',
    children: [{ id: 'n1', role: 'heading', name: 'Check your email' }],
  };
}
function fakeSnapshot(): AxSnapshot {
  return { root: fakeTree(), text: 'heading "Check your email"', truncated: false };
}

class FakeEmailBrowser implements BrowserPort {
  async launch(): Promise<void> {}
  async navigate(_url: string): Promise<void> {}
  async url(): Promise<string> {
    return 'http://localhost:3000/verify';
  }
  async axTree(): Promise<AxSnapshot> {
    return fakeSnapshot();
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

/** Fixed navigator: replies with each plan in `plans` in order (no plan-goals
 * capability advertised → runDriverLoop runs navigator-only, one implicit
 * goal). Mirrors v27.run-data.ts's extractCapablePlanner shape. */
function fixedPlanner(plans: unknown[]): ModelAdapter {
  let i = 0;
  return {
    name: 'fake-navigator',
    rung: 1,
    available: async () => true,
    supports: (c: Capability) => c === 'plan-step',
    generateJson: async (_req: JsonRequest) => {
      const p = plans[Math.min(i, plans.length - 1)];
      i++;
      return p;
    },
  };
}

function tmpArtifacts(): ArtifactStore {
  return new ArtifactStore(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-art-email-')));
}

console.log('=== v66: wait_for_email — success + OTP extraction (real polling) ===');
{
  const email = new FakeLocalEmailProvider();
  const router = new ModelRouter([
    fixedPlanner([
      { thought: 'wait for the verification email', actions: [{ type: 'wait_for_email', matching: 'verification code', extractOtpTo: 'otp', timeoutMs: 5000 }] },
      { thought: 'stop here (no visual model)', actions: [{ type: 'finish', verdict: 'fail', reason: 'stop here (no visual model)' }] },
    ]),
  ]);

  // Deliver the email AFTER the run starts, so the action must actually poll
  // rather than find it on the first pass.
  setTimeout(() => {
    email.deliver({
      to: 'qa@example.test',
      subject: 'Your verification code',
      text: 'Use 482913 to finish signup.',
    });
  }, 200);

  const report = await runDriverLoop(new FakeEmailBrowser(), router, tmpArtifacts(), 'verify signup email', 'http://localhost:3000/verify', {
    maxSteps: 4,
    allowedHosts: ['localhost'],
    emailProvider: email,
  });

  check('wait_for_email step succeeded once the matching email arrived', report.steps[0]?.ok === true);
  check('OTP extracted into {{run.otp}}', report.run_data?.run.otp === '482913');
  check('OTP extraction is tagged source: email', report.run_data?.extractions.otp?.source === 'email');
}

console.log('\n=== v66: wait_for_email — matching filter ignores a non-matching email ===');
{
  const email = new FakeLocalEmailProvider();
  email.deliver({ to: 'qa@example.test', subject: 'Welcome!', text: 'Thanks for signing up.' });
  const router = new ModelRouter([
    fixedPlanner([
      { thought: 'wait for a code email that never arrives', actions: [{ type: 'wait_for_email', matching: 'verification code', timeoutMs: 1000 }] },
      { thought: 'done', actions: [{ type: 'finish', verdict: 'fail', reason: 'stop here (no visual model)' }] },
    ]),
  ]);

  const report = await runDriverLoop(new FakeEmailBrowser(), router, tmpArtifacts(), 'verify signup email', 'http://localhost:3000/verify', {
    maxSteps: 4,
    allowedHosts: ['localhost'],
    emailProvider: email,
  });

  check('non-matching email does not satisfy the filter (step fails after timeout)', report.steps[0]?.ok === false);
  check('failure message cites the timeout', /no email matching/.test(report.steps[0]?.error ?? ''));
}

console.log('\n=== v66: wait_for_email — no email provider configured fails cleanly ===');
{
  const router = new ModelRouter([
    fixedPlanner([
      { thought: 'wait for an email with no provider wired', actions: [{ type: 'wait_for_email', extractOtpTo: 'otp' }] },
      { thought: 'done', actions: [{ type: 'finish', verdict: 'fail', reason: 'stop here (no visual model)' }] },
    ]),
  ]);

  const report = await runDriverLoop(new FakeEmailBrowser(), router, tmpArtifacts(), 'verify signup email', 'http://localhost:3000/verify', {
    maxSteps: 4,
    allowedHosts: ['localhost'],
    // emailProvider intentionally omitted — QaConfig.emailProvider defaults to 'none'.
  });

  check('step fails', report.steps[0]?.ok === false);
  check(
    'clean, actionable error message',
    report.steps[0]?.error === "no email provider configured — set emailProvider: 'fake-local' (or a future real provider)",
  );
  check('no OTP was extracted', report.run_data?.run.otp === undefined);
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v66 checks passed`);
process.exit(failed.length ? 1 : 0);
