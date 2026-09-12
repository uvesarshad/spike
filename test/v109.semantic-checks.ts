/* v109 — E10: the three semantic checks a hand-assembled app fails silently.
 *
 * None of these produce a console error, a failed request, or a blank screen,
 * so every existing check on the page comes back clean while the user is
 * looking at something obviously wrong:
 *
 *   1. a raw text key on screen ("common.errors.notFound") instead of the
 *      words it stands for;
 *   2. "NaN" / "undefined" / a zero total sitting where a price belongs;
 *   3. a form submission the server accepted (200) that left the page exactly
 *      as it was.
 *
 * Covers (pure — no Chrome, no AI, no network):
 *   1/4  the on-page script, run over a hand-built page, finds each bug and
 *        stays quiet on the healthy version of the same page;
 *   2/4  the reader turns those readings into WARNINGS, and honours the
 *        per-project "this is fine on my app" allow-list and the off switch;
 *   3/4  the accepted-but-inert submission rule fires only on a same-site
 *        write that really was accepted and really changed nothing;
 *   4/4  it reaches the saved report through the real driver loop, on the step
 *        that pressed the button.
 *
 * Run: npx tsx test/v109.semantic-checks.ts   (exits nonzero on any failed check)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  INVARIANT_PROBE_JS,
  checkProbeInvariants,
  checkSubmitEffect,
  type InvariantViolation,
} from '../src/assertions/invariants.js';
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

const has = (violations: InvariantViolation[], rule: string) => violations.some((v) => v.rule === rule);

// ---------------------------------------------------------------------------
// A hand-built page, just rich enough for the on-page script to walk.
//
// Deliberately NOT a full DOM: the script wraps every section in its own
// try/catch, so the parts this shim doesn't model (images, landmarks, loading
// indicators, duplicate ids) simply come back empty. What IS modelled is the
// visible-text walk the three E10 rules ride on — parents, siblings, text
// content and visibility — which is exactly the surface under test.
// ---------------------------------------------------------------------------

class FakeText {
  parentElement: FakeEl | null = null;
  constructor(public nodeValue: string) {}
}

class FakeEl {
  readonly tagName: string;
  readonly childNodes: (FakeEl | FakeText)[] = [];
  parentElement: FakeEl | null = null;
  /** Non-null so the script's visibility test treats it as on screen. */
  readonly offsetParent: unknown = {};
  readonly id: string;
  readonly className: string;

  constructor(
    tag: string,
    private readonly attrs: Record<string, string> = {},
  ) {
    this.tagName = tag.toUpperCase();
    this.id = attrs.id ?? '';
    this.className = attrs.class ?? '';
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  get textContent(): string {
    return this.childNodes.map((c) => (c instanceof FakeText ? c.nodeValue : c.textContent)).join('');
  }

  private get elementSiblings(): FakeEl[] {
    return (this.parentElement?.childNodes ?? []).filter((c): c is FakeEl => c instanceof FakeEl);
  }

  get previousElementSibling(): FakeEl | null {
    const sibs = this.elementSiblings;
    return sibs[sibs.indexOf(this) - 1] ?? null;
  }

  get nextElementSibling(): FakeEl | null {
    const sibs = this.elementSiblings;
    return sibs[sibs.indexOf(this) + 1] ?? null;
  }

  matches(selector: string): boolean {
    if (selector === '[aria-hidden="true"]') return this.getAttribute('aria-hidden') === 'true';
    if (selector === 'a[href]') return this.tagName === 'A' && this.getAttribute('href') !== null;
    return false;
  }

  closest(selector: string): FakeEl | null {
    let cur: FakeEl | null = this;
    while (cur) {
      if (cur.matches(selector)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }
}

/** el('div', {class: 'price'}, 'Total: ', el('span', {}, '$NaN')) */
function el(tag: string, attrs: Record<string, string>, ...kids: (FakeEl | string)[]): FakeEl {
  const node = new FakeEl(tag, attrs);
  for (const kid of kids) {
    const child = typeof kid === 'string' ? new FakeText(kid) : kid;
    child.parentElement = node;
    node.childNodes.push(child);
  }
  return node;
}

function textNodesOf(root: FakeEl): FakeText[] {
  const out: FakeText[] = [];
  const walk = (node: FakeEl) => {
    for (const child of node.childNodes) {
      if (child instanceof FakeText) out.push(child);
      else walk(child);
    }
  };
  walk(root);
  return out;
}

/** Run the real on-page script against a hand-built page. */
function probe(body: FakeEl): Record<string, unknown> {
  const nodes = textNodesOf(body);
  let cursor = 0;
  const document = {
    body,
    documentElement: body,
    createTreeWalker: () => ({ nextNode: () => nodes[cursor++] ?? null }),
    querySelectorAll: () => [] as unknown[],
    querySelector: () => null,
  };
  const window = { getComputedStyle: () => ({ display: 'block', visibility: 'visible', position: 'static' }) };
  const NodeFilter = { SHOW_TEXT: 4 };
  // parenthesised deliberately: the script literal opens with a newline, and a
  // bare `return` followed by one returns undefined.
  const run = new Function('document', 'window', 'NodeFilter', `return (${INVARIANT_PROBE_JS});`) as (
    d: unknown,
    w: unknown,
    n: unknown,
  ) => Record<string, unknown>;
  return run(document, window, NodeFilter);
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

console.log('=== v109 1/4: the on-page script, over a hand-built page ===');
{
  // --- a raw text key on screen ---
  const broken = probe(
    el('body', {}, el('main', {}, el('h2', {}, 'common.errors.notFound'), el('p', {}, 'checkout.summary.total_label'))),
  );
  const keys = strings(broken.untranslatedKeys);
  check('a raw text key is spotted', keys.includes('common.errors.notFound'));
  check('an underscored key segment is spotted too', keys.includes('checkout.summary.total_label'));

  const clean = probe(
    el(
      'body',
      {},
      el(
        'main',
        {},
        el('h2', {}, 'Page not found'),
        el('p', {}, 'Order total'),
        // the shapes that merely LOOK like a key
        el('a', { href: 'https://docs.example.com/start' }, 'docs.example.com'),
        el('code', {}, 'app.module.css'),
        el('span', {}, 'Version 3.11.2'),
      ),
    ),
  );
  check('the translated page is quiet', strings(clean.untranslatedKeys).length === 0);
}

{
  // --- a price that failed to compute ---
  const broken = probe(
    el(
      'body',
      {},
      el(
        'main',
        {},
        el('div', { class: 'line' }, 'Subtotal: $NaN'),
        el('div', { class: 'row' }, el('span', {}, 'Shipping'), el('span', {}, '$undefined')),
        el('div', { class: 'row' }, el('span', {}, 'Price'), el('span', {}, '$0.00')),
      ),
    ),
  );
  const values = strings(broken.brokenValues);
  check('"NaN" next to a currency symbol is spotted', values.some((v) => v.includes('NaN')));
  check('"undefined" in a neighbouring price cell is spotted', values.some((v) => v.includes('undefined')));
  check('a zero total is spotted', values.some((v) => v.includes('$0.00')));

  const clean = probe(
    el(
      'body',
      {},
      el(
        'main',
        {},
        el('div', { class: 'line' }, 'Subtotal: $42.00'),
        el('div', { class: 'row' }, el('span', {}, 'Shipping'), el('span', {}, '$4.99')),
        // "undefined" with no price anywhere near it is somebody else's rule
        el('p', {}, 'Reading an undefined variable is a common mistake.'),
      ),
    ),
  );
  check('a healthy price list is quiet', strings(clean.brokenValues).length === 0);
}

console.log('\n=== v109 2/4: the readings become warnings ===');
{
  const violations = checkProbeInvariants({
    untranslatedKeys: ['common.errors.notFound'],
    brokenValues: ['Subtotal: $NaN'],
  });
  check('a raw text key is reported', has(violations, 'untranslated-text'));
  check('a broken price is reported', has(violations, 'broken-price'));
  check(
    'both are warnings, never failures',
    violations.filter((v) => v.rule === 'untranslated-text' || v.rule === 'broken-price').every((v) => v.severity === 'warn'),
  );
  check(
    'the sentences avoid jargon',
    violations.find((v) => v.rule === 'untranslated-text')?.detail === 'The page shows a raw text key instead of the words it stands for.' &&
      violations.find((v) => v.rule === 'broken-price')?.detail === 'A price on the page shows a broken or empty value.',
  );
  check('the offending text is kept as evidence', violations.find((v) => v.rule === 'broken-price')?.evidence === 'Subtotal: $NaN');
}

{
  const clean = checkProbeInvariants({ untranslatedKeys: [], brokenValues: [] });
  check('a clean reading reports neither', !has(clean, 'untranslated-text') && !has(clean, 'broken-price'));

  const allowed = checkProbeInvariants(
    { untranslatedKeys: ['common.errors.notFound'], brokenValues: ['Credit: $0.00'] },
    { allowText: ['common.errors.notFound', 'Credit'] },
  );
  check('text the project says is fine on this app is not reported', !has(allowed, 'untranslated-text') && !has(allowed, 'broken-price'));

  const off = checkProbeInvariants({ untranslatedKeys: ['a.b.c'], brokenValues: ['$NaN'] }, { disabled: ['untranslated-text', 'broken-price'] });
  check('both checks can be switched off per project', !has(off, 'untranslated-text') && !has(off, 'broken-price'));

  check('junk from the page is survived', checkProbeInvariants({ untranslatedKeys: 'nope', brokenValues: [1, null] }).length === 0);
}

console.log('\n=== v109 3/4: accepted, and yet nothing happened ===');
{
  const accepted: NetworkEntry = { ts: 1, method: 'POST', url: 'https://shop.example.com/api/order', status: 200 };
  const url = 'https://shop.example.com/checkout';

  const fired = checkSubmitEffect({ network: [accepted], pageChanged: false, url, targetName: 'Place order' });
  check('an accepted write that changed nothing is reported', has(fired, 'inert-submit'));
  check('it is a warning', fired[0]?.severity === 'warn');
  check('the sentence names the control', !!fired[0]?.detail.includes('Place order'));
  check('the sentence is plain English', !!fired[0]?.detail.includes('nothing on the page changed'));

  check(
    'a submission that DID change the page is not reported',
    !has(checkSubmitEffect({ network: [accepted], pageChanged: true, url }), 'inert-submit'),
  );
  check(
    'a rejected submission is left to the request checks',
    !has(checkSubmitEffect({ network: [{ ...accepted, status: 500, failed: true }], pageChanged: false, url }), 'inert-submit'),
  );
  check(
    'a background read is not a submission',
    !has(checkSubmitEffect({ network: [{ ...accepted, method: 'GET' }], pageChanged: false, url }), 'inert-submit'),
  );
  check(
    'a third-party write says nothing about this app',
    !has(
      checkSubmitEffect({ network: [{ ...accepted, url: 'https://analytics.example.net/collect' }], pageChanged: false, url }),
      'inert-submit',
    ),
  );
  check('a quiet step reports nothing', checkSubmitEffect({ network: [], pageChanged: false, url }).length === 0);
  check(
    'it can be switched off per project',
    !has(checkSubmitEffect({ network: [accepted], pageChanged: false, url, config: { disabled: ['inert-submit'] } }), 'inert-submit'),
  );
}

console.log('\n=== v109 4/4: it reaches the saved report ===');
{
  /** One button. Pressing it posts an order the server happily accepts, and
   * then the page does absolutely nothing. */
  class FakeBrowser implements BrowserPort {
    pressed = 0;
    private pending: NetworkEntry[] = [];
    currentUrl = 'https://shop.example.com/checkout';
    private tree(): AxNode {
      return { id: 'root', role: 'WebArea', children: [{ id: 'n1', role: 'button', name: 'Place order' }] };
    }
    async launch(): Promise<void> {}
    async navigate(url: string): Promise<void> {
      this.currentUrl = url;
    }
    async url(): Promise<string> {
      return this.currentUrl;
    }
    async axTree(): Promise<AxSnapshot> {
      const root = this.tree();
      return { root, text: JSON.stringify(root), truncated: false };
    }
    async click(): Promise<void> {
      this.pressed++;
      this.pending.push({ ts: Date.now(), method: 'POST', url: 'https://shop.example.com/api/order', status: 200 });
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
      return 'tab-0';
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
      const out = this.pending;
      this.pending = [];
      return out;
    }
    async close(): Promise<void> {}
  }

  function stubNavigator(): ModelAdapter {
    let call = 0;
    return {
      name: 'stub-navigator',
      rung: 1,
      available: async () => true,
      supports: (c: Capability) => c === 'plan-step',
      generateJson: async (_req: JsonRequest) => {
        call++;
        if (call === 1) return { thought: 'submit the order', actions: [{ type: 'click', nodeId: 'n1' }] };
        return { thought: 'done', actions: [{ type: 'finish', verdict: 'pass', reason: 'submitted the order' }] };
      },
    };
  }

  const browser = new FakeBrowser();
  const router = new ModelRouter([stubNavigator()]);
  const artifacts = new ArtifactStore(fs.mkdtempSync(path.join(os.tmpdir(), 'spike-art-')));
  const report = await runDriverLoop(browser, router, artifacts, 'place an order', browser.currentUrl, {
    maxSteps: 6,
    allowedHosts: ['shop.example.com'],
  });

  const clickStep = report.steps.find((s) => s.action.type === 'click');
  const inert = clickStep?.invariants?.find((v) => v.rule === 'inert-submit');
  check('the button really was pressed', browser.pressed === 1);
  check('the step carries the accepted-but-inert warning', !!inert);
  check('the warning names the button', !!inert?.detail.includes('Place order'));
  check('the request is kept as evidence', !!inert?.evidence?.includes('/api/order'));
  check('the step itself is still recorded as ok', clickStep?.ok === true);
  check('the run is not force-failed by the warning', report.verdict !== 'fail');
}

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  console.error(`\n${failed.length} checks failed:`);
  for (const [label] of failed) console.error(` - ${label}`);
  process.exit(1);
}

console.log(`\nV109 semantic-check coverage passed (${checks.length}).`);
