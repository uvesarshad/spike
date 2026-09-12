/* v82 — A9 (P0): the inbox is real, and the wait-for-email verb is only
 * offered when there is one.
 *
 * Before this, the driver advertised `wait_for_email` on every run while no
 * production call site ever built a provider, so the model planned it and
 * burned a guaranteed failure. Now the verb's existence follows the wiring:
 * with no inbox it is stripped from BOTH the navigator's prompt and its
 * response schema; with one it works exactly as before.
 *
 * The real IMAP path (src/email/imap.ts) is not exercised here — it needs a
 * live mail server. What IS covered is everything around it: the config/env
 * surface that selects it, the prompt/schema gate, and the configurable
 * throwaway-address domain.
 *
 * Run: npx tsx test/v82.email-provider.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeLocalEmailProvider } from '../src/email/index.js';
import { IMAPFLOW_MISSING_MESSAGE, toEmailMessage } from '../src/email/imap.js';
import { loadConfig } from '../src/config.js';
import { actionRulesAndVocabulary } from '../src/driver/planner-prompt.js';
import { planJsonSchema } from '../src/driver/actions.js';
import { runDriverLoop } from '../src/driver/loop.js';
import { ArtifactStore } from '../src/report/artifacts.js';
import { ModelRouter } from '../src/router/model-router.js';
import type { Capability, JsonRequest, ModelAdapter } from '../src/router/adapter.js';
import type { AxNode, AxSnapshot, BrowserPort, ConsoleEntry, LogpointSpec, NetworkEntry } from '../src/ports/browser-port.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

function fakeSnapshot(): AxSnapshot {
  const root: AxNode = { id: 'root', role: 'WebArea', children: [{ id: 'n1', role: 'heading', name: 'Check your email' }] };
  return { root, text: 'heading "Check your email"', truncated: false };
}

class FakeBrowser implements BrowserPort {
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

/** Records every prompt + schema the navigator was actually given. */
function recordingPlanner(plans: unknown[], seen: JsonRequest[]): ModelAdapter {
  let i = 0;
  return {
    name: 'fake-navigator',
    rung: 1,
    available: async () => true,
    supports: (c: Capability) => c === 'plan-step',
    generateJson: async (req: JsonRequest) => {
      seen.push(req);
      const p = plans[Math.min(i, plans.length - 1)];
      i++;
      return p;
    },
  };
}

function tmpArtifacts(): ArtifactStore {
  return new ArtifactStore(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-art-mail-')));
}

function enumOf(schema: object): string[] {
  const s = schema as { properties: { actions: { items: { properties: { type: { enum: string[] } } } } } };
  return s.properties.actions.items.properties.type.enum;
}

console.log('=== v82: vocabulary + schema gate (pure) ===');
{
  const withEmail = actionRulesAndVocabulary({ emailEnabled: true });
  const without = actionRulesAndVocabulary({ emailEnabled: false });
  check('the verb is described when an inbox is wired', withEmail.includes('wait_for_email'));
  check('no mention of the verb at all without one', !without.includes('wait_for_email'));
  check('the rest of the vocabulary survives the strip', without.includes('"type":"extract"') && without.includes('"type":"finish"'));
  check('only the two email lines are removed', without.split('\n').length === withEmail.split('\n').length - 2);

  check('schema offers the verb when an inbox is wired', enumOf(planJsonSchema({ emailEnabled: true })).includes('wait_for_email'));
  check('schema drops the verb without one', !enumOf(planJsonSchema({ emailEnabled: false })).includes('wait_for_email'));
  check('every other verb stays in the schema', enumOf(planJsonSchema({ emailEnabled: false })).length === enumOf(planJsonSchema({ emailEnabled: true })).length - 1);
  check('the shared schema constant is never mutated', enumOf(planJsonSchema({ emailEnabled: true })).includes('wait_for_email'));
}

console.log('\n=== v82: emailProvider "none" — the model is never offered the verb ===');
{
  const seen: JsonRequest[] = [];
  const router = new ModelRouter([
    recordingPlanner([{ thought: 'stop', actions: [{ type: 'finish', verdict: 'fail', reason: 'stop here (no visual model)' }] }], seen),
  ]);
  await runDriverLoop(new FakeBrowser(), router, tmpArtifacts(), 'verify the signup email', 'http://localhost:3000/verify', {
    maxSteps: 3,
    allowedHosts: ['localhost'],
    // no emailProvider — QaConfig.emailProvider 'none'
  });
  check('the navigator was called', seen.length > 0);
  check('the prompt never mentions the verb', seen.every((r) => !r.prompt.includes('wait_for_email')));
  check('the response schema never offers the verb', seen.every((r) => !enumOf(r.schema).includes('wait_for_email')));
}

console.log('\n=== v82: emailProvider "fake-local" — the verb is offered and works ===');
{
  const seen: JsonRequest[] = [];
  const email = new FakeLocalEmailProvider();
  email.deliver({ to: 'qa@example.test', subject: 'Your verification code', text: 'Use 552104 to finish signup.' });
  const router = new ModelRouter([
    recordingPlanner(
      [
        { thought: 'read the code', actions: [{ type: 'wait_for_email', matching: 'verification code', extractOtpTo: 'otp', timeoutMs: 2000 }] },
        { thought: 'stop', actions: [{ type: 'finish', verdict: 'fail', reason: 'stop here (no visual model)' }] },
      ],
      seen,
    ),
  ]);
  const report = await runDriverLoop(new FakeBrowser(), router, tmpArtifacts(), 'verify the signup email', 'http://localhost:3000/verify', {
    maxSteps: 3,
    allowedHosts: ['localhost'],
    emailProvider: email,
  });
  check('the prompt describes the verb', seen[0]?.prompt.includes('wait_for_email') === true);
  check('the response schema offers the verb', enumOf(seen[0]!.schema).includes('wait_for_email'));
  check('the step reached the inbox and succeeded', report.steps[0]?.ok === true);
  check('the code was pulled out of the email', report.run_data?.run.otp === '552104');
}

console.log('\n=== v82: the throwaway address domain is configurable ===');
{
  const seen: JsonRequest[] = [];
  const router = new ModelRouter([
    recordingPlanner([{ thought: 'stop', actions: [{ type: 'finish', verdict: 'fail', reason: 'stop here (no visual model)' }] }], seen),
  ]);
  const dflt = await runDriverLoop(new FakeBrowser(), router, tmpArtifacts(), 'sign up', 'http://localhost:3000/verify', {
    maxSteps: 2,
    allowedHosts: ['localhost'],
  });
  check('default domain unchanged', (dflt.run_data?.run.email as string).endsWith('@example.test'));

  const custom = await runDriverLoop(new FakeBrowser(), router, tmpArtifacts(), 'sign up', 'http://localhost:3000/verify', {
    maxSteps: 2,
    allowedHosts: ['localhost'],
    runEmailDomain: 'inbox.mytest.dev',
  });
  check('configured domain is used', (custom.run_data?.run.email as string).endsWith('@inbox.mytest.dev'));
}

console.log('\n=== v82: config/env surface ===');
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-cfg-mail-'));
  const base = { ...process.env };
  try {
    process.env.SPIKE_EMAIL_PROVIDER = 'imap';
    process.env.SPIKE_IMAP_HOST = 'imap.example.com';
    process.env.SPIKE_IMAP_USER = 'qa@example.com';
    process.env.SPIKE_IMAP_PASS = 'app-password';
    process.env.SPIKE_IMAP_MAILBOX = 'Spike';
    process.env.SPIKE_RUN_EMAIL_DOMAIN = 'inbox.mytest.dev';
    const cfg = loadConfig({}, cwd);
    check('the inbox kind is selectable', cfg.emailProvider === 'imap');
    check('server reaches config', cfg.imapHost === 'imap.example.com');
    check('account reaches config', cfg.imapUser === 'qa@example.com');
    check('mailbox reaches config', cfg.imapMailbox === 'Spike');
    check('address domain reaches config', cfg.runEmailDomain === 'inbox.mytest.dev');
    check('the password NEVER lands in config', !JSON.stringify(cfg).includes('app-password'));
  } finally {
    process.env = base;
  }

  const dflt = loadConfig({}, fs.mkdtempSync(path.join(os.tmpdir(), 'qa-cfg-mail2-')));
  check('no inbox by default', dflt.emailProvider === 'none');
  check('no address-domain override by default', dflt.runEmailDomain === undefined);
}

console.log('\n=== v82: IMAP message shaping (no server needed) ===');
{
  const msg = toEmailMessage({
    uid: 42,
    envelope: {
      subject: 'Your verification code',
      date: new Date('2026-09-13T10:00:00Z'),
      from: [{ address: 'no-reply@app.example' }],
      to: [{ address: 'qa+abc@inbox.mytest.dev' }],
    },
    source: Buffer.from('Subject: Your verification code\r\nMessage-Id: <99887766@app.example>\r\n\r\nYour code is 314159.\r\n'),
  });
  check('subject/from/to come from the envelope', msg.subject === 'Your verification code' && msg.from === 'no-reply@app.example' && msg.to === 'qa+abc@inbox.mytest.dev');
  check('headers are stripped from the body', !msg.text.includes('99887766'));
  check('the body survives', msg.text.includes('314159'));
  check('a missing package is explained, not crashed on', /npm install imapflow/.test(IMAPFLOW_MISSING_MESSAGE));
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v82 checks passed`);
process.exit(failed.length ? 1 : 0);
