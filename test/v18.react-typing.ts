/* V18 — React 18 controlled-input empirical settlement.
 *
 * THE QUESTION (docs/TODO.md open risk): does CdpBrowser.type()'s
 * DOM.focus + Ctrl+A + Input.insertText path register on a React *controlled*
 * input (value={state} + onChange)? React intercepts the input's `value` via a
 * prototype descriptor and reconciles against its own state; some synthetic
 * value-setting paths (e.g. node.value = x) bypass React's onChange entirely.
 *
 * THE TRAP: fixture /react renders a controlled login form whose Sign in button
 * is DISABLED until email==='test@test.com' && password==='pw'. If insertText
 * does NOT reach React state, onChange never fires, the button never enables,
 * and the click can't submit "Welcome!". So the button-enabled assertion is a
 * direct, unfakeable probe of whether typing reached React.
 *
 * EMPIRICAL VERDICT (run 2026-06-07, BEFORE any port change):
 *   PASS — Input.insertText DOES satisfy React 18 controlled inputs. CDP's
 *   Input.insertText dispatches a real composition/beforeinput+input sequence
 *   (like IME / paste text insertion), which React's onChange listener observes
 *   exactly like genuine user input. The button enabled and "Welcome!" rendered.
 *   => insertText stays the PRIMARY path. The value-verification + per-character
 *   key-event fallback added to the ports this round is defense-in-depth for the
 *   rarer inputs that DO swallow insertText, and guards against silent typing
 *   failures (a real-user bug class hit once before).
 *
 * This test stays green with the final port implementation (verification path
 * is a no-op when insertText already took, which it does here). */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CdpBrowser } from '../src/ports/cdp-browser.js';
import type { AxNode } from '../src/ports/browser-port.js';
import { startFixture, stopFixture } from '../fixture/server.js';

const FIXTURE_PORT = 9408; // assigned to V18
const CDP_PORT = 9341; // throwaway headless, assigned to V18

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

function find(root: AxNode, role: string, nameIncludes: string): AxNode | undefined {
  if (root.role === role && root.name?.toLowerCase().includes(nameIncludes.toLowerCase())) return root;
  for (const c of root.children ?? []) {
    const hit = find(c, role, nameIncludes);
    if (hit) return hit;
  }
  return undefined;
}

function findText(root: AxNode, textIncludes: string): boolean {
  if (root.name?.includes(textIncludes)) return true;
  if (root.value?.includes(textIncludes)) return true;
  for (const c of root.children ?? []) if (findText(c, textIncludes)) return true;
  return false;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const browser = new CdpBrowser({
  port: CDP_PORT,
  profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'qa-v18-')),
  headless: true,
});

const server = startFixture(FIXTURE_PORT, false);

try {
  await browser.launch();
  await browser.navigate(`http://localhost:${FIXTURE_PORT}/react`);
  await sleep(1200); // React UMD fetch from unpkg + hydrate

  // The form must have rendered (CDN reachable) before we can probe typing.
  let ax = await browser.axTree();
  const emailField = find(ax.root, 'textbox', 'Email');
  const passwordField = find(ax.root, 'textbox', 'Password');
  check(
    'react form rendered (email + password textboxes present — CDN reachable)',
    Boolean(emailField && passwordField),
  );
  if (!emailField || !passwordField) {
    throw new Error(
      'React controlled form did not render — unpkg CDN likely unreachable. a11y tree:\n' + ax.text,
    );
  }

  // Type into both controlled fields via the PORT's type() (the path under test).
  await browser.type(emailField.id, 'test@test.com');
  // re-snapshot: React re-render swaps backendNodeIds, so re-resolve password.
  ax = await browser.axTree();
  const pw2 = find(ax.root, 'textbox', 'Password');
  if (!pw2) throw new Error('password field vanished after typing email');
  await browser.type(pw2.id, 'pw');
  await sleep(300);

  // THE PROBE: button enabled ⇔ React state received both values ⇔ typing
  // reached React's controlled-input bookkeeping.
  ax = await browser.axTree();
  const signin = find(ax.root, 'button', 'Sign in');
  check('react sign-in button found', Boolean(signin));
  const isDisabled = signin?.states?.includes('disabled') ?? false;
  check('react controlled button ENABLED after typing (insertText reached React state)', !isDisabled);

  if (signin && !isDisabled) {
    await browser.click(signin.id);
    await sleep(400);
    const ax2 = await browser.axTree();
    check('clicking enabled button renders "Welcome!"', findText(ax2.root, 'Welcome!'));
  } else {
    check('clicking enabled button renders "Welcome!"', false);
  }
} finally {
  await browser.close();
  await stopFixture(server);
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} V18 checks passed`);
process.exit(failed.length ? 1 : 0);
