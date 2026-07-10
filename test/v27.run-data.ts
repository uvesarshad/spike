/* v27 - Runtime data, extraction state, and fake local email provider.
 *
 * This is intentionally offline and driver-free. Driver/recorder integration
 * hooks are documented in docs/architecture/data-flow.md and docs/modules/recorder.md.
 *
 * Run: npx tsx test/v27.run-data.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {
  createRunDataState,
  extractRegexToRunData,
  getRunData,
  recordExtraction,
  resolveRunPlaceholders,
  RunDataNotFoundError,
} from '../src/run-data/index.js';
import { FakeLocalEmailProvider, findOtp } from '../src/email/index.js';
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

const state = createRunDataState({ shortid: 'abc123', emailDomain: 'mail.test' });
check('shortid is seeded deterministically', state.run.shortid === 'abc123');
check('email is generated from shortid + domain', state.run.email === 'qa+abc123@mail.test');
check('name and phone defaults exist', Boolean(state.run.name) && /^\+1555\d{4}$/.test(state.run.phone));

const resolved = resolveRunPlaceholders('Sign up {{run.email}} as {{run.name}} / {{run.phone}}', state);
check('resolver replaces all built-in {{run.*}} placeholders', resolved.text === `Sign up ${state.run.email} as ${state.run.name} / ${state.run.phone}`);
check('resolver returns resolution metadata', resolved.resolved.map((r) => r.key).join(',') === 'email,name,phone');

let missing: unknown;
try {
  resolveRunPlaceholders('Order {{run.orderId}}', state);
} catch (e) {
  missing = e;
}
check('unknown run placeholder throws by default', missing instanceof RunDataNotFoundError && missing.key === 'orderId');

const preserved = resolveRunPlaceholders('Order {{run.orderId}}', state, { unknown: 'preserve' });
check('unknown run placeholder can be preserved for planner-visible text', preserved.text === 'Order {{run.orderId}}');

const extraction = recordExtraction(state, {
  key: 'orderId',
  value: 'ORD-42',
  source: 'dom',
  label: 'confirmation number',
  at: '2026-07-07T00:00:00.000Z',
});
check('recordExtraction writes run value', getRunData(state, 'orderId') === 'ORD-42');
check('recordExtraction stores source metadata', state.extractions.orderId === extraction && extraction.source === 'dom');
check('extracted values resolve as later {{run.*}} placeholders', resolveRunPlaceholders('Track {{run.orderId}}', state).text === 'Track ORD-42');

const regexState = createRunDataState({ shortid: 'rx' });
const found = extractRegexToRunData(regexState, 'Receipt total: $19.99; Order #ZX-900', [
  { key: 'total', pattern: /total:\s*\$([0-9.]+)/i, label: 'receipt total' },
  { key: 'orderId', pattern: /Order #(?<id>[A-Z]+-\d+)/, group: 'id' },
]);
check('extractRegexToRunData records multiple values', found.length === 2 && regexState.run.total === '19.99' && regexState.run.orderId === 'ZX-900');

const email = new FakeLocalEmailProvider();
email.deliver({
  to: state.run.email,
  subject: 'Your verification code',
  text: 'Use 482913 to finish signup.',
  receivedAt: '2026-07-07T01:00:00.000Z',
});
email.deliver({
  to: 'other@mail.test',
  subject: 'Your verification code',
  text: 'Use 111111 to finish signup.',
});

const messages = await email.listMessages({ to: state.run.email, subjectIncludes: 'verification' });
check('fake email provider filters by recipient and subject', messages.length === 1 && messages[0].to === state.run.email);
check('findOtp extracts code from matching email', messages[0] !== undefined && findOtp(messages[0]) === '482913');

const waited = await email.waitForMessage({ to: state.run.email, bodyIncludes: '482913' }, { timeoutMs: 50, intervalMs: 5 });
check('waitForMessage returns an existing local email', waited?.id === messages[0].id);

const timedOut = await email.waitForMessage({ to: state.run.email, bodyIncludes: 'never arrives' }, { timeoutMs: 20, intervalMs: 5 });
check('waitForMessage returns null on timeout', timedOut === null);

assert.throws(() => recordExtraction(state, { key: 'bad.key', value: 'x', source: 'manual' }), /invalid run data key/);
check('unsafe extraction keys are rejected', true);

/* ------------------------------------------------------------------------- *
 * DRIVER: Phase 15 — model-assisted structured extraction. `extract` with a
 * `prompt` routes through router.planJson() (the SAME text call the
 * navigator uses — no vision, no new router surface); `extract` WITHOUT a
 * prompt keeps the $0 DOM-text/regex path; a later {{run.*}} reference
 * resolves whichever value landed there. Same hand-rolled FAKE BrowserPort +
 * real-ModelRouter harness as v13.tier4.ts/v32.script-runner.ts.
 * ------------------------------------------------------------------------- */
console.log('\n=== v27 DRIVER: Phase 15 model-assisted extraction ===');
{
  function fakeTree(): AxNode {
    return {
      id: 'root',
      role: 'WebArea',
      children: [
        { id: 'n1', role: 'heading', name: 'Order confirmed' },
        { id: 'n2', role: 'text', name: 'Your confirmation code is CODE-123-ABC.' },
        { id: 'n3', role: 'textbox', name: 'Reference' },
      ],
    };
  }
  function fakeSnapshot(): AxSnapshot {
    return {
      root: fakeTree(),
      text: 'heading "Order confirmed"\ntext "Your order ORD-999 confirmed. Your confirmation code is CODE-123-ABC."\ntextbox "Reference"',
      truncated: false,
    };
  }

  class FakeExtractBrowser implements BrowserPort {
    typed: { nodeId: string; text: string }[] = [];
    async launch(): Promise<void> {}
    async navigate(_url: string): Promise<void> {}
    async url(): Promise<string> {
      return 'http://localhost:3000/success';
    }
    async axTree(): Promise<AxSnapshot> {
      return fakeSnapshot();
    }
    async click(): Promise<void> {}
    async type(nodeId: string, text: string): Promise<void> {
      this.typed.push({ nodeId, text });
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

  /** A mock TEXT adapter serving BOTH the navigator's plan-step calls and the
   * extract-with-prompt call — discriminated by prompt content (the SAME
   * capability, 'plan-step', per Phase 15's routing: no new router surface). */
  function extractCapablePlanner(plans: unknown[]): ModelAdapter {
    let i = 0;
    return {
      name: 'fake-extract-planner',
      rung: 1,
      available: async () => true,
      supports: (c: Capability) => c === 'plan-step',
      generateJson: async (req: JsonRequest) => {
        if (req.prompt.includes('Extract a single value from the page text below')) {
          return { value: 'ORD-999' };
        }
        const p = plans[Math.min(i, plans.length - 1)];
        i++;
        return p;
      },
    };
  }

  function tmpArtifacts(): ArtifactStore {
    return new ArtifactStore(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-art-extract-')));
  }

  const browser = new FakeExtractBrowser();
  const router = new ModelRouter([
    extractCapablePlanner([
      { thought: 'model-assisted extract of the order id', actions: [{ type: 'extract', key: 'orderId', prompt: 'the order id shown on this confirmation page' }] },
      { thought: 'DOM-regex extract of the confirmation code ($0 default)', actions: [{ type: 'extract', nodeId: 'n2', key: 'confirmationCode', pattern: 'CODE-[0-9A-Z-]+' }] },
      { thought: 'reference the extracted order id in a later step', actions: [{ type: 'type', nodeId: 'n3', text: 'Reference: {{run.orderId}}' }] },
      { thought: 'done', actions: [{ type: 'finish', verdict: 'fail', reason: 'stop here (no visual model)' }] },
    ]),
  ]);

  const report = await runDriverLoop(browser, router, tmpArtifacts(), 'extract order details', 'http://localhost:3000/success', {
    maxSteps: 6,
    allowedHosts: ['localhost'],
  });

  check('model-assisted extraction stores the structured value', report.run_data?.run.orderId === 'ORD-999');
  check('model-assisted extraction is tagged source: model', report.run_data?.extractions.orderId?.source === 'model');
  check('extract WITHOUT a prompt falls back to the $0 DOM-text/regex path', report.run_data?.run.confirmationCode === 'CODE-123-ABC');
  check('DOM-fallback extraction is tagged source: dom', report.run_data?.extractions.confirmationCode?.source === 'dom');
  check('a later {{run.orderId}} reference resolves the model-extracted value', browser.typed[0]?.text === 'Reference: ORD-999');
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v27 checks passed`);
process.exit(failed.length ? 1 : 0);
