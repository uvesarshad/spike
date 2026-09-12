/* v81 — A9 (P0): popup sign-in guard + adopted popup tabs.
 *
 * Two halves:
 *   1. the name matcher (src/driver/sso-popup.ts) — which buttons read as a
 *      third-party sign-in popup, and which ordinary login buttons must NOT;
 *   2. the driver behaviour — a transport that cannot adopt a popup (no
 *      BrowserPort.takeNewTabs) refuses the click BEFORE it happens and ends
 *      with the plain sentence, while a transport that CAN (the shape
 *      CdpBrowser now implements) clicks normally and tells the navigator the
 *      new tab's id so switch_tab can reach it.
 *
 * Same hand-rolled FAKE BrowserPort + real-ModelRouter harness as
 * v66.email-otp.ts. No Chrome, no network.
 *
 * Run: npx tsx test/v81.sso-popup.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDriverLoop } from '../src/driver/loop.js';
import { detectSsoPopupClick, isSsoPopupButtonName, SSO_POPUP_UNSUPPORTED_REASON } from '../src/driver/sso-popup.js';
import { ArtifactStore } from '../src/report/artifacts.js';
import { ModelRouter } from '../src/router/model-router.js';
import type { Capability, JsonRequest, ModelAdapter } from '../src/router/adapter.js';
import type { AxNode, AxSnapshot, BrowserPort, ConsoleEntry, LogpointSpec, NetworkEntry, NewTabInfo } from '../src/ports/browser-port.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

function fakeTree(): AxNode {
  return {
    id: 'root',
    role: 'WebArea',
    children: [
      { id: 'n1', role: 'button', name: 'Sign in with Google' },
      { id: 'n2', role: 'button', name: 'Sign in' },
    ],
  };
}
function fakeSnapshot(): AxSnapshot {
  return { root: fakeTree(), text: 'button "Sign in with Google"\nbutton "Sign in"', truncated: false };
}

/** A transport with NO takeNewTabs — the in-browser extension ports' shape. */
class SingleTabBrowser implements BrowserPort {
  clicks: string[] = [];
  async launch(): Promise<void> {}
  async navigate(_url: string): Promise<void> {}
  async url(): Promise<string> {
    return 'http://localhost:3000/login';
  }
  async axTree(): Promise<AxSnapshot> {
    return fakeSnapshot();
  }
  async click(nodeId: string): Promise<void> {
    this.clicks.push(nodeId);
  }
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

/** A transport that CAN adopt a popup: the click opens one, and takeNewTabs
 * hands it over exactly once — CdpBrowser's contract, without Chrome. */
class PopupCapableBrowser extends SingleTabBrowser {
  private queued: NewTabInfo[] = [];
  override async click(nodeId: string): Promise<void> {
    this.clicks.push(nodeId);
    if (nodeId === 'n1') this.queued.push({ id: 'POPUP1', url: 'https://accounts.example.com/oauth' });
  }
  async takeNewTabs(): Promise<NewTabInfo[]> {
    const out = this.queued;
    this.queued = [];
    return out;
  }
}

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
  return new ArtifactStore(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-art-sso-')));
}

console.log('=== v81: sign-in popup button names ===');
{
  for (const name of [
    'Sign in with Google',
    'sign in with google',
    'Sign In With Microsoft',
    'Continue with GitHub',
    'Log in with Apple',
    'Sign up with Google',
    'Connect with GitHub',
  ]) {
    check(`recognised: ${name}`, isSsoPopupButtonName(name));
  }
  for (const name of ['Sign in', 'Log in', 'Sign in with your email address', 'Continue', 'Google', undefined]) {
    check(`not a popup button: ${String(name)}`, !isSsoPopupButtonName(name));
  }
  check('a popup-capable transport never triggers the guard', detectSsoPopupClick('click', 'Sign in with Google', true) === null);
  check('only a click triggers the guard', detectSsoPopupClick('hover', 'Sign in with Google', false) === null);
  check('a blocked click returns the plain reason', detectSsoPopupClick('click', 'Sign in with Google', false) === SSO_POPUP_UNSUPPORTED_REASON);
}

console.log('\n=== v81: single-tab transport refuses the popup sign-in click ===');
{
  const browser = new SingleTabBrowser();
  const router = new ModelRouter([
    fixedPlanner([
      { thought: 'use the Google button', actions: [{ type: 'click', nodeId: 'n1' }] },
      { thought: 'done', actions: [{ type: 'finish', verdict: 'fail', reason: 'stop here (no visual model)' }] },
    ]),
  ]);

  const report = await runDriverLoop(browser, router, tmpArtifacts(), 'log in and open the dashboard', 'http://localhost:3000/login', {
    maxSteps: 4,
    allowedHosts: ['localhost'],
  });

  check('the click was never dispatched', browser.clicks.length === 0);
  check('the step is recorded as failed', report.steps[0]?.ok === false);
  check('the step error is the plain sentence', report.steps[0]?.error === SSO_POPUP_UNSUPPORTED_REASON);
  check('the run ends uncertain (not a bug in the app under test)', report.verdict === 'uncertain');
  check('the run reason is the plain sentence, verbatim', report.reason === SSO_POPUP_UNSUPPORTED_REASON);
  check('no jargon in the user-facing reason', !/popup target|CDP|window\.open|SSO|OAuth/i.test(report.reason ?? ''));
}

console.log('\n=== v81: an ordinary login button is untouched by the guard ===');
{
  const browser = new SingleTabBrowser();
  const router = new ModelRouter([
    fixedPlanner([
      { thought: 'use the plain login button', actions: [{ type: 'click', nodeId: 'n2' }] },
      { thought: 'done', actions: [{ type: 'finish', verdict: 'fail', reason: 'stop here (no visual model)' }] },
    ]),
  ]);

  const report = await runDriverLoop(browser, router, tmpArtifacts(), 'log in and open the dashboard', 'http://localhost:3000/login', {
    maxSteps: 4,
    allowedHosts: ['localhost'],
  });

  check('the plain login click still runs', browser.clicks.includes('n2'));
  check('the run is not stopped by the popup guard', report.reason !== SSO_POPUP_UNSUPPORTED_REASON);
}

console.log('\n=== v81: a popup-capable transport clicks through and reports the new tab ===');
{
  const browser = new PopupCapableBrowser();
  const router = new ModelRouter([
    fixedPlanner([
      { thought: 'use the Google button', actions: [{ type: 'click', nodeId: 'n1' }] },
      { thought: 'done', actions: [{ type: 'finish', verdict: 'fail', reason: 'stop here (no visual model)' }] },
    ]),
  ]);

  const report = await runDriverLoop(browser, router, tmpArtifacts(), 'log in and open the dashboard', 'http://localhost:3000/login', {
    maxSteps: 4,
    allowedHosts: ['localhost'],
  });

  check('the click WAS dispatched (no guard)', browser.clicks.includes('n1'));
  check('the step succeeded', report.steps[0]?.ok === true);
  check('the new tab id reaches the step history for switch_tab', (report.steps[0]?.description ?? '').includes('POPUP1'));
  check('the run is not stopped by the popup guard', report.reason !== SSO_POPUP_UNSUPPORTED_REASON);
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} v81 checks passed`);
process.exit(failed.length ? 1 : 0);
