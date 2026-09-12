/* v13 — Tier-4 security core. No AI, no Chrome: everything runs against a
 * hand-rolled FAKE BrowserPort + scripted FAKE planner adapters so the whole
 * suite is deterministic and offline.
 *
 * Covers:
 *  1. Vault roundtrip (set/get/list/delete) + the on-disk blob is genuinely
 *     encrypted (the raw file does not contain the plaintext).
 *  2. {{secret:NAME}} resolution + redaction: the browser receives the REAL
 *     value at type() time, while steps/report/audit hold only the placeholder.
 *  3. Read-only guard: a type/click on a non-allowed host ends the run
 *     'uncertain' citing the guard, and the mutation never executes.
 *
 *  Run: npx tsx test/v13.tier4.ts   (exits nonzero on any failed check)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault, FileKeyProvider } from '../src/vault/vault.js';
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

/* ===================== 1) Vault roundtrip + encryption ===================== */
console.log('=== v13 1/3: vault roundtrip + at-rest encryption ===');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-vault-'));
  const vault = new Vault({ dir, keyProvider: new FileKeyProvider(path.join(dir, "key.bin")) });
  const SECRET = 'hunter2-super-secret-value';

  vault.set('LOGIN_PW', SECRET);
  vault.set('API_TOKEN', 'tok_abc');
  check('get() returns the stored value', vault.get('LOGIN_PW') === SECRET);
  check('list() returns both names sorted', JSON.stringify(vault.list()) === JSON.stringify(['API_TOKEN', 'LOGIN_PW']));
  check('get() of unknown name is undefined', vault.get('NOPE') === undefined);

  const encPath = path.join(dir, 'secrets.enc');
  const raw = fs.readFileSync(encPath);
  check('secrets.enc exists', fs.existsSync(encPath));
  // The default key backend is platform-dependent since #8: DPAPI on Windows
  // (key.dpapi), key.bin elsewhere / for pre-existing vaults.
  check(
    'key file exists (key.dpapi on win32 / key.bin otherwise)',
    fs.existsSync(path.join(dir, process.platform === 'win32' ? 'key.dpapi' : 'key.bin')),
  );
  check('raw file does NOT contain the plaintext (encrypted at rest)', !raw.toString('binary').includes(SECRET));
  check('raw file does NOT contain the secret name in plaintext', !raw.toString('binary').includes('LOGIN_PW'));

  check('delete() of known name returns true', vault.delete('API_TOKEN') === true);
  check('delete() of unknown name returns false', vault.delete('NOPE') === false);
  check('deleted secret is gone, other remains', vault.get('API_TOKEN') === undefined && vault.get('LOGIN_PW') === SECRET);

  // a fresh Vault over the same dir + key decrypts (key persistence works)
  const reopened = new Vault({ dir, keyProvider: new FileKeyProvider(path.join(dir, "key.bin")) });
  check('reopened vault decrypts existing secret', reopened.get('LOGIN_PW') === SECRET);
}

/* ===================== fake harness ===================== */

/** A minimal AxNode tree with one textbox + one button. */
function fakeTree(): AxNode {
  return {
    id: 'root',
    role: 'WebArea',
    children: [
      { id: 'n1', role: 'textbox', name: 'Password' },
      { id: 'n2', role: 'button', name: 'Sign in' },
    ],
  };
}

function fakeSnapshot(): AxSnapshot {
  return { root: fakeTree(), text: 'textbox "Password" n1\nbutton "Sign in" n2', truncated: false };
}

/** FAKE BrowserPort: captures every type() call's text, serves a fixed tree,
 * and reports a configurable url() (drives the read-only guard). */
class FakeBrowser implements BrowserPort {
  typed: { nodeId: string; text: string }[] = [];
  clicked: string[] = [];
  navigated: string[] = [];
  constructor(public currentUrl: string) {}
  async launch(): Promise<void> {}
  async navigate(url: string): Promise<void> {
    this.navigated.push(url);
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
  async type(nodeId: string, text: string): Promise<void> {
    this.typed.push({ nodeId, text });
  }
  async hover(_nodeId: string): Promise<void> {}
  async pressKey(_key: string): Promise<void> {}
  async selectOption(_nodeId: string, _value: string): Promise<void> {}
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
    // a minimal PNG-shaped buffer so saveScreenshot writes something
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

/** A scripted planner adapter: returns the queued plan JSON for each plan-step
 * call in order; supports plan-step only (no visuals needed here). */
function scriptedPlanner(plans: unknown[]): ModelAdapter {
  let i = 0;
  return {
    name: 'fake-planner',
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
  return new ArtifactStore(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-art-')));
}

/* ===================== 2) secret resolution + redaction ===================== */
console.log('\n=== v13 2/3: {{secret}} resolution + redaction ===');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-vault2-'));
  const vault = new Vault({ dir, keyProvider: new FileKeyProvider(path.join(dir, "key.bin")) });
  const REAL = 'p@ssw0rd-REAL-VALUE';
  vault.set('LOGIN_PW', REAL);

  const browser = new FakeBrowser('http://localhost:3000/login');
  // batch: type the secret placeholder, click sign in → then a finish:pass.
  const router = new ModelRouter([
    scriptedPlanner([
      {
        thought: 'fill the password then sign in',
        actions: [
          { type: 'type', nodeId: 'n1', text: '{{secret:LOGIN_PW}}' },
          { type: 'click', nodeId: 'n2' },
        ],
      },
      { thought: 'done', actions: [{ type: 'finish', verdict: 'fail', reason: 'stop here (no visual model)' }] },
    ]),
  ]);
  const artifacts = tmpArtifacts();

  const report = await runDriverLoop(browser, router, artifacts, 'log in', 'http://localhost:3000/login', {
    maxSteps: 6,
    allowedHosts: ['localhost'],
    vault,
  });

  check('browser.type() received the RESOLVED real secret value', browser.typed.length === 1 && browser.typed[0].text === REAL);

  const reportJson = JSON.stringify(report);
  check('report JSON contains the placeholder', reportJson.includes('{{secret:LOGIN_PW}}'));
  check('report JSON does NOT contain the real secret value', !reportJson.includes(REAL));

  const typeStep = report.steps.find((s) => s.action.type === 'type');
  check(
    'StepRecord.action keeps the placeholder text (not the value)',
    typeStep !== undefined && typeStep.action.type === 'type' && typeStep.action.text === '{{secret:LOGIN_PW}}',
  );

  const auditPath = path.join(artifacts.dir, 'audit.log');
  check('audit.log exists', fs.existsSync(auditPath));
  const auditRaw = fs.readFileSync(auditPath, 'utf8');
  const auditLines = auditRaw.trim().split('\n').filter(Boolean);
  // one line per executed action: type, click, finish
  check('audit.log has one line per executed action (type + click + finish)', auditLines.length === 3);
  check('audit type line carries the textbox target, not the secret', JSON.parse(auditLines[0]).target === 'textbox "Password"');
  check('audit.log does NOT contain the real secret value', !auditRaw.includes(REAL));
  const firstAudit = JSON.parse(auditLines[0]);
  check('audit entry has ts/runId/action/url/ok shape', typeof firstAudit.ts === 'number' && firstAudit.action === 'type' && typeof firstAudit.ok === 'boolean' && typeof firstAudit.url === 'string');
}

/* ----- missing secret → step fails with the qa-cli hint ----- */
console.log('\n--- missing-secret path ---');
{
  const browser = new FakeBrowser('http://localhost:3000/login');
  const router = new ModelRouter([
    scriptedPlanner([
      { thought: 'type a missing secret', actions: [{ type: 'type', nodeId: 'n1', text: '{{secret:DOES_NOT_EXIST}}' }] },
      { thought: 'stop', actions: [{ type: 'finish', verdict: 'fail', reason: 'stop' }] },
    ]),
  ]);
  const vault3Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-vault3-'));
  const vault = new Vault({ dir: vault3Dir, keyProvider: new FileKeyProvider(path.join(vault3Dir, 'key.bin')) });
  const report = await runDriverLoop(browser, router, tmpArtifacts(), 'x', 'http://localhost:3000/login', {
    maxSteps: 4,
    allowedHosts: ['localhost'],
    vault,
  });
  const typeStep = report.steps.find((s) => s.action.type === 'type');
  check('missing secret → type step failed', typeStep !== undefined && typeStep.ok === false);
  check(
    'missing secret error names the secret + the qa cli hint',
    typeStep?.error?.includes('DOES_NOT_EXIST') === true && typeStep?.error?.includes('spike secret set') === true,
  );
  check('missing secret → browser.type never called', browser.typed.length === 0);
}

/* ===================== 3) read-only guard ===================== */
console.log('\n=== v13 3/3: read-only-by-default guard ===');
{
  const browser = new FakeBrowser('https://evil.example.com/account');
  const router = new ModelRouter([
    scriptedPlanner([
      { thought: 'try to click delete', actions: [{ type: 'click', nodeId: 'n2' }] },
    ]),
  ]);
  const report = await runDriverLoop(browser, router, tmpArtifacts(), 'delete my account', 'https://evil.example.com/account', {
    maxSteps: 6,
    allowedHosts: ['localhost', '127.0.0.1'],
  });
  check('read-only run ends verdict uncertain', report.verdict === 'uncertain');
  // A14: this is a HOST block, not look-only mode — the two are different
  // things and the reason no longer conflates them.
  check('the reason names the host block + the host', /blocked host/.test(report.reason) && report.reason.includes('evil.example.com'));
  check('read-only: click never executed', browser.clicked.length === 0);
  check('read-only: step budget not burned (ended immediately)', report.steps.length === 0);
}

/* ----- subdomain-of an allowed host: A45 (P2) tightened this to opt-in only —
 * a bare entry ('localhost') no longer trusts every subdomain (that was too
 * broad for multi-tenant hosts like *.vercel.app); a '.'-prefixed entry
 * ('.localhost') still does. ----- */
{
  const browser = new FakeBrowser('http://app.localhost:3000/');
  const router = new ModelRouter([
    scriptedPlanner([{ thought: 'x', actions: [{ type: 'click', nodeId: 'n2' }] }]),
  ]);
  const report = await runDriverLoop(browser, router, tmpArtifacts(), 'x', 'http://app.localhost:3000/', {
    maxSteps: 4,
    allowedHosts: ['localhost'],
  });
  check('A45: a bare allowedHosts entry no longer trusts a subdomain (click blocked)', browser.clicked.length === 0);
  check('A45: the bare-entry subdomain run tripped the host guard', /blocked host/.test(report.reason));
}
{
  const browser = new FakeBrowser('http://app.localhost:3000/');
  const router = new ModelRouter([
    scriptedPlanner([
      { thought: 'click', actions: [{ type: 'click', nodeId: 'n2' }] },
      { thought: 'done', actions: [{ type: 'finish', verdict: 'fail', reason: 'stop' }] },
    ]),
  ]);
  const report = await runDriverLoop(browser, router, tmpArtifacts(), 'x', 'http://app.localhost:3000/', {
    maxSteps: 4,
    allowedHosts: ['.localhost'],
  });
  check('A45: a "."-prefixed entry still permits a subdomain (click ran)', browser.clicked.length === 1);
  check('A45: the opted-in subdomain run did not trip the read-only guard', !/read-only mode/.test(report.reason));
}

/* ----- abort signal ----- */
console.log('\n--- abort signal ---');
{
  const browser = new FakeBrowser('http://localhost:3000/');
  const controller = new AbortController();
  controller.abort(); // already aborted before the loop starts
  const router = new ModelRouter([
    scriptedPlanner([{ thought: 'x', actions: [{ type: 'click', nodeId: 'n2' }] }]),
  ]);
  const report = await runDriverLoop(browser, router, tmpArtifacts(), 'x', 'http://localhost:3000/', {
    maxSteps: 4,
    allowedHosts: ['localhost'],
    signal: controller.signal,
  });
  check('aborted run ends uncertain', report.verdict === 'uncertain');
  check('aborted run reason is "cancelled by user"', report.reason === 'cancelled by user');
  check('aborted run executed no actions', browser.clicked.length === 0 && report.steps.length === 0);
}

/* ===================== summary ===================== */
const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v13 checks passed`);
process.exit(failed.length ? 1 : 0);
