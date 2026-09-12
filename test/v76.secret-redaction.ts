/**
 * V76 — typed credentials never reach a stored or displayed run (audit A5).
 *
 * A password the user typed into the task text used to travel verbatim: into
 * the step record, into report.json, into the plain-English report shown in the
 * panel, and into the fix prompt people are told to paste into a third-party
 * coding tool. This suite pins that it does not:
 *
 *   1. a type into a credential-looking field is stored as "•••";
 *   2. the same value is absent from the plain-English report;
 *   3. a {{secret:NAME}} placeholder survives untouched (it is already safe and
 *      is what makes a recorded script replayable);
 *   4. ordinary fields (a search box) still show what was typed;
 *   5. the plain-English report hides a plaintext password even in a report the
 *      driver never produced (second line of defence).
 *
 * Pure/in-memory: fake browser, fake model. No Chrome, no network, no keys.
 *
 * Run: npx tsx test/v76.secret-redaction.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDriverLoop } from '../src/driver/loop.js';
import { ArtifactStore } from '../src/report/artifacts.js';
import { isSecretTarget, redactSecretText, redactTaskText, redactTypedText } from '../src/report/redact.js';
import type { Report, StepRecord } from '../src/report/report.js';
import { renderPlainReport, buildFixPrompt, humanizeStep } from '../src/vibe/fix-prompt.js';
import type { AxNode, AxSnapshot, BrowserPort, ConsoleEntry, NetworkEntry } from '../src/ports/browser-port.js';
import type { ModelRouter } from '../src/router/model-router.js';

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

const PLAINTEXT_PASSWORD = 'hunter2-in-the-clear';
const SEARCH_TERM = 'blue running shoes';

/* ---- a login page with a password box, an email box and a search box ------ */

class LoginPage implements BrowserPort {
  /** Every value the page was actually asked to type, in order. */
  readonly typed: string[] = [];

  async launch(): Promise<void> {}
  async navigate(): Promise<void> {}
  async url(): Promise<string> {
    return 'http://localhost/login';
  }
  async axTree(): Promise<AxSnapshot> {
    const root: AxNode = {
      id: 'root',
      role: 'document',
      name: 'Sign in',
      children: [
        { id: 'n1', role: 'textbox', name: 'Email' },
        { id: 'n2', role: 'textbox', name: 'Password' },
        { id: 'n3', role: 'searchbox', name: 'Search products' },
        { id: 'n4', role: 'button', name: 'Sign in' },
      ],
    };
    return {
      root,
      text: 'document "Sign in"\n  textbox "Email"\n  textbox "Password"\n  searchbox "Search products"\n  button "Sign in"',
      truncated: false,
    };
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

/** Types the email, the password and a search term, then finishes. */
function loginRouter() {
  let call = 0;
  const plans: unknown[] = [
    {
      thought: 'fill the sign-in form',
      actions: [
        { type: 'type', nodeId: 'n1', text: 'shopper@example.com' },
        { type: 'type', nodeId: 'n2', text: PLAINTEXT_PASSWORD },
        { type: 'type', nodeId: 'n3', text: SEARCH_TERM },
      ],
    },
    { thought: 'signed in', actions: [{ type: 'finish', verdict: 'pass', reason: 'signed in' }] },
  ];
  const router = {
    trace: [],
    async hasCapability(): Promise<boolean> {
      return false; // single-model setup: one implicit goal, no separate planner
    },
    async planJson(): Promise<unknown> {
      return plans[Math.min(call++, plans.length - 1)];
    },
    async visualVerdict(): Promise<unknown> {
      return { verdict: 'pass', summary: 'signed in', issues: [] };
    },
  };
  return router as unknown as ModelRouter;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-v76-'));
const browser = new LoginPage();
const report = await runDriverLoop(
  browser,
  loginRouter(),
  new ArtifactStore(path.join(root, 'artifacts')),
  'log in as the test shopper and search for shoes',
  'http://localhost/login',
  { maxSteps: 12, allowedHosts: ['localhost'], readOnly: false },
);

const serialized = JSON.stringify(report);
const plain = renderPlainReport(report);
const fixPrompt = buildFixPrompt(report);

await check('the page still received the real password (redaction is display-only)', () => {
  assert.ok(
    browser.typed.includes(PLAINTEXT_PASSWORD),
    `the browser must still be typed the real value, got ${JSON.stringify(browser.typed)}`,
  );
});

await check('the stored step for the password field holds no plaintext', () => {
  const step = report.steps.find(
    (s): s is StepRecord => s.action.type === 'type' && s.target?.name === 'Password',
  );
  assert.ok(step, 'expected a recorded type into the Password field');
  assert.equal(step.action.type === 'type' ? step.action.text : '', '•••');
  assert.ok(!step.description.includes(PLAINTEXT_PASSWORD), `description leaked: ${step.description}`);
});

await check('the password is nowhere in the whole report object', () => {
  assert.ok(!serialized.includes(PLAINTEXT_PASSWORD), 'report.json would have carried the password');
});

await check('the plain-English report and the fix prompt hold no plaintext', () => {
  assert.ok(!plain.includes(PLAINTEXT_PASSWORD), `plain report leaked:\n${plain}`);
  assert.ok(!fixPrompt.includes(PLAINTEXT_PASSWORD), 'fix prompt leaked the password');
});

await check('an ordinary field still shows what was typed', () => {
  assert.ok(plain.includes(SEARCH_TERM), `a search term must stay readable:\n${plain}`);
});

/* ---- the rule itself ------------------------------------------------------ */

await check('credential-looking fields are recognised, ordinary ones are not', () => {
  for (const name of ['Password', 'Confirm password', 'One-time code OTP', 'Card number', 'CVV', 'API token']) {
    assert.ok(isSecretTarget({ role: 'textbox', name }), `${name} should count as a credential field`);
  }
  for (const name of ['Email', 'Search products', 'First name', 'Street address']) {
    assert.ok(!isSecretTarget({ role: 'textbox', name }), `${name} should stay readable`);
  }
  assert.ok(isSecretTarget({ role: 'textbox', testId: 'login-password' }), 'a test id counts too');
});

await check('a {{secret:NAME}} placeholder survives redaction untouched', () => {
  assert.equal(redactSecretText('{{secret:TEST_PASSWORD}}'), '{{secret:TEST_PASSWORD}}');
  assert.equal(
    redactTypedText('{{secret:TEST_PASSWORD}}', { role: 'textbox', name: 'Password' }),
    '{{secret:TEST_PASSWORD}}',
    'the vaulted form is already safe and must stay replayable',
  );
  // a literal glued onto a placeholder still loses the literal half
  assert.equal(redactSecretText('prefix-{{secret:PW}}'), '•••{{secret:PW}}');
});

await check('the plain report hides a plaintext password from a hand-built report', () => {
  const step: StepRecord = {
    index: 0,
    action: { type: 'type', nodeId: 'n2', text: PLAINTEXT_PASSWORD },
    description: 'type into n2',
    target: { role: 'textbox', name: 'Password' },
    ok: true,
    console: [],
    network: [],
    ts: 1,
  } as StepRecord;
  assert.ok(!humanizeStep(step).includes(PLAINTEXT_PASSWORD), 'humanizeStep is the second line of defence');
  const handBuilt: Report = {
    verdict: 'fail',
    task: 'log in',
    reason: 'the sign-in button did nothing',
    steps: [step],
  } as unknown as Report;
  assert.ok(!renderPlainReport(handBuilt).includes(PLAINTEXT_PASSWORD), 'plain report leaked');
});

/* ---- the task string a person typed by hand ------------------------------ */

await check('a credential pasted into the task is stripped where it is stored', () => {
  assert.equal(
    redactTaskText('log in with shopper@example.com / hunter2 and check the dashboard'),
    'log in with [redacted] and check the dashboard',
  );
  assert.equal(redactTaskText('sign in, password: hunter2, then check out'), 'sign in, [redacted] then check out');
  assert.equal(redactTaskText('use pin=4821 at the kiosk'), 'use [redacted] at the kiosk');
});

await check('an ordinary task survives untouched', () => {
  const plainTask = 'add an item to the cart and complete checkout';
  assert.equal(redactTaskText(plainTask), plainTask);
  assert.equal(redactTaskText('email shopper@example.com a receipt'), 'email shopper@example.com a receipt');
});

await check('a {{secret:NAME}} task stays intact and replayable', () => {
  const vaulted = 'Use {{secret:TEST_USER}} / {{secret:TEST_PASSWORD}} to log in';
  assert.equal(redactTaskText(vaulted), vaulted);
});

await check('a run stored on disk carries the redacted task, not the typed one', async () => {
  const store = new ArtifactStore(path.join(root, 'stored'));
  const credentialed: Report = {
    verdict: 'pass',
    task: `log in with shopper@example.com / ${PLAINTEXT_PASSWORD}`,
    reason: 'signed in',
    steps: [],
    url: 'http://localhost/login',
  } as unknown as Report;
  const written = await store.saveReport(credentialed);
  const onDisk = fs.readFileSync(written, 'utf8');
  assert.ok(!onDisk.includes(PLAINTEXT_PASSWORD), 'report.json carried the password');
  assert.ok(onDisk.includes('[redacted]'), 'expected the credential to read as [redacted]');
  assert.equal(
    credentialed.task,
    `log in with shopper@example.com / ${PLAINTEXT_PASSWORD}`,
    'the in-memory task the model works from must not be altered',
  );
});

await check('the plain report and fix prompt hide a credentialed task', () => {
  const credentialed: Report = {
    verdict: 'fail',
    task: `log in with shopper@example.com / ${PLAINTEXT_PASSWORD}`,
    reason: 'the sign-in button did nothing',
    steps: [],
    console_error: null,
    failing_step: null,
    evidence_paths: [],
  } as unknown as Report;
  assert.ok(!renderPlainReport(credentialed).includes(PLAINTEXT_PASSWORD), 'plain report leaked the task');
  assert.ok(!buildFixPrompt(credentialed).includes(PLAINTEXT_PASSWORD), 'fix prompt leaked the task');
});

fs.rmSync(root, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nV76 OK');
