/** A14 — authenticator codes: RFC 6238 vectors, placeholder resolution, redacted record. */
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

import { generateTotp, resolveTotpPlaceholders } from '../src/auth/totp.js';

const raw = Buffer.from('12345678901234567890');
const vectors: [number, string][] = [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']];
for (const [t, code] of vectors) assert.equal(generateTotp('', t * 1000, { raw }), code, `t=${t}`);

// base32 of the RFC secret
const b32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
assert.equal(generateTotp(b32, 59_000), '287082');

const vault = { get: (n: string) => (n === 'TOTP_STAGING' ? b32 : undefined) };
assert.equal(resolveTotpPlaceholders('{{totp:STAGING}}', vault, 59_000), '287082');
assert.equal(resolveTotpPlaceholders('plain', vault), 'plain');
assert.throws(() => resolveTotpPlaceholders('{{totp:NOPE}}', vault), /spike secret set TOTP_NOPE/);
assert.throws(() => resolveTotpPlaceholders('{{totp:NOPE}}', { get: () => undefined, totpUnavailable: 'needs the desktop helper' }), /desktop helper/);
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


const b32b = b32;
const browser = new LoginPage();
let call = 0;
const plans: unknown[] = [
  { thought: 'code', actions: [{ type: 'type', nodeId: 'n3', text: '{{totp:STAGING}}' }] },
  { thought: 'done', actions: [{ type: 'finish', verdict: 'pass', reason: 'ok' }] },
];
const router = {
  trace: [],
  async hasCapability() { return false; },
  async planJson() { return plans[Math.min(call++, plans.length - 1)]; },
  async visualVerdict() { return { verdict: 'pass', summary: 'ok', issues: [] }; },
} as unknown as ModelRouter;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-v113-'));
const report = await runDriverLoop(browser, router, new ArtifactStore(path.join(root, 'a')), 'enter the code', 'http://localhost/login', {
  maxSteps: 6, allowedHosts: ['localhost'], readOnly: false, vault: { get: (n: string) => (n === 'TOTP_STAGING' ? b32b : undefined) },
});
assert.match(browser.typed[0] ?? '', /^\d{6}$/, 'page got a 6-digit code');
const step = report.steps.find((s) => s.action.type === 'type');
assert.ok(step && !step.description.match(/\d{6}/), `description leaked: ${step?.description}`);
assert.ok(step?.description.includes('•••'), step?.description);
assert.ok(!JSON.stringify(report).includes(browser.typed[0]!), 'code not in report');
console.log('PASS v150 totp');
