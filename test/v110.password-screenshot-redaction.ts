/* v110 — E15: a password field must not be legible in a saved screenshot.
 *
 * Screenshots land on disk on every failure, go into the evidence bundle, get
 * sent to a visual model, and travel to whoever the user forwards the report
 * to. The browser masks a password field's value, but that is the app's
 * choice, not ours — a "show password" toggle, a field the app builds out of a
 * plain text input, or a password manager's inline preview all put a real
 * secret in the picture. So anything in a password field's box is obscured
 * before the picture is taken.
 *
 * Covers (pure — no Chrome, no pixels, no network):
 *   1/4  the arithmetic: a reported box becomes a padded, whole-pixel region
 *        clamped to the page, and junk is dropped rather than trusted;
 *   2/4  the painting script carries NUMBERS ONLY, so nothing the page says can
 *        come back as code;
 *   3/4  the decision: a page with a password field is obscured then restored,
 *        a page without one is captured untouched, and a page that refuses to
 *        cooperate still yields a screenshot rather than losing the evidence;
 *   4/4  all three browser connections do it, not just one — the same login
 *        page must not be redacted or not depending on how it was reached.
 *
 * Run: npx tsx test/v110.password-screenshot-redaction.ts   (exits nonzero on any failed check)
 */

import fs from 'node:fs';
import {
  CLEAR_BLUR_OVERLAY_JS,
  REDACTION_MARKER_ATTR,
  SECRET_FIELD_PROBE_JS,
  buildBlurOverlayScript,
  parseSecretBoxes,
  toBlurRegions,
  withSecretFieldsHidden,
  type RedactionOutcome,
} from '../src/assertions/screenshot-redaction.js';
import { LiteExtensionBrowser } from '../src/extension/lite-extension-browser.js';
import { ExtensionBrowser } from '../src/ports/extension-browser.js';
import type { CdpTransport } from '../src/bridge/cdp-shim.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

console.log('=== v110 1/4: box → the rectangle actually painted over ===');
{
  const regions = toBlurRegions([{ x: 100.4, y: 50.6, width: 220.2, height: 32.1 }], { padding: 6 });
  const r = regions[0];
  check('one box in, one region out', regions.length === 1);
  check('the region starts a padding above and to the left, snapped outwards', r?.x === 94 && r?.y === 44);
  check(
    'and ends a padding below and to the right, snapped outwards',
    !!r && r.x + r.width === Math.ceil(100.4 + 220.2 + 6) && r.y + r.height === Math.ceil(50.6 + 32.1 + 6),
  );
  check('every edge is a whole pixel', !!r && Number.isInteger(r.x) && Number.isInteger(r.y) && Number.isInteger(r.width) && Number.isInteger(r.height));
  check('the region is strictly bigger than the field', !!r && r.width > 220.2 && r.height > 32.1);
}

{
  // A field at the very top-left, and one hanging off the bottom-right.
  const regions = toBlurRegions(
    [
      { x: 2, y: 1, width: 40, height: 20 },
      { x: 780, y: 590, width: 60, height: 40 },
    ],
    { padding: 8, docWidth: 800, docHeight: 600 },
  );
  check('a region never starts off the picture', regions.every((r) => r.x >= 0 && r.y >= 0));
  check(
    'a region never ends past the page',
    regions.every((r) => r.x + r.width <= 800 && r.y + r.height <= 600),
  );
  check('a clamped region still covers the visible part of the field', (regions[1]?.width ?? 0) > 0 && (regions[1]?.height ?? 0) > 0);
}

{
  const junk = toBlurRegions([
    { x: NaN, y: 0, width: 10, height: 10 },
    { x: 0, y: 0, width: Infinity, height: 10 },
    { x: 10, y: 10, width: 0, height: 10 },
  ] as never);
  check('nonsense boxes are dropped, not painted', junk.length === 0);
  check('a box entirely off the page clamps away to nothing', toBlurRegions([{ x: -500, y: -500, width: 100, height: 100 }], { padding: 0, docWidth: 800, docHeight: 600 }).length === 0);
  check('no padding still yields the field itself', toBlurRegions([{ x: 10, y: 20, width: 30, height: 40 }], { padding: 0 })[0]?.width === 30);
}

console.log('\n=== v110 2/4: what the page is handed ===');
{
  const raw = {
    boxes: [
      { x: 10, y: 20, width: 100, height: 30 },
      { x: 'nope', y: 20, width: 100, height: 30 },
      { x: 10, y: 20, width: 0, height: 30 },
    ],
    docWidth: 1280,
    docHeight: 900,
  };
  const reading = parseSecretBoxes(raw);
  check('only the usable boxes survive the page', reading.boxes.length === 1);
  check('the page size comes through for clamping', reading.docWidth === 1280 && reading.docHeight === 900);
  check('a page that returned junk reads as "no fields"', parseSecretBoxes('nope').boxes.length === 0 && parseSecretBoxes(null).boxes.length === 0);
  check('an error payload reads as "no fields"', parseSecretBoxes({ error: 'blocked' }).boxes.length === 0);
}

{
  const script = buildBlurOverlayScript([{ x: 12, y: 34, width: 56, height: 78 }]) ?? '';
  check('the painting script carries the region', script.includes('{"x":12,"y":34,"w":56,"h":78}'));
  check('it marks what it paints so it can be cleaned up', script.includes(REDACTION_MARKER_ATTR));
  check('it blurs rather than merely tinting', script.includes('blur(8px)'));
  check('nothing to paint means no script at all', buildBlurOverlayScript([]) === null);

  // The one safety property that matters: the generated source is numeric
  // literals. A page that somehow got text into a box must not get code back.
  const hostile = buildBlurOverlayScript([{ x: 1, y: 2, width: 3, height: 4 }, { x: "');alert(1);//" as never, y: 0, width: 9, height: 9 }]) ?? '';
  check('text a page smuggled into a box never reaches the script', !hostile.includes('alert(1)'));
  const payload = hostile.match(/var R = (\[.*?\]);/)?.[1] ?? '';
  check(
    'every value in the script is a plain number',
    payload.length > 0 &&
      (JSON.parse(payload) as Record<string, unknown>[]).every((r) => Object.values(r).every((v) => typeof v === 'number')),
  );

  for (const source of [SECRET_FIELD_PROBE_JS, CLEAR_BLUR_OVERLAY_JS, script]) {
    let parses = true;
    try {
      new Function(`return (${source});`);
    } catch {
      parses = false;
    }
    check('the script is valid JavaScript', parses);
  }
}

console.log('\n=== v110 3/4: obscure, capture, put the page back ===');
{
  /** Stands in for the page. Reports whatever boxes the test wants, and
   * records every script it was asked to run, in order. */
  function fakePage(boxes: unknown, opts: { refuse?: boolean } = {}) {
    const seen: string[] = [];
    const evaluate = async (expression: string): Promise<unknown> => {
      seen.push(expression);
      if (opts.refuse) throw new Error('Cannot access contents of the page');
      if (expression === SECRET_FIELD_PROBE_JS) return { boxes, docWidth: 1280, docHeight: 900 };
      return 1;
    };
    return { evaluate, seen };
  }

  const box = [{ x: 100, y: 200, width: 240, height: 36 }];

  {
    const page = fakePage(box);
    let outcome: RedactionOutcome | null = null;
    let capturedWhilePainted = false;
    const shot = await withSecretFieldsHidden(
      page.evaluate,
      async () => {
        capturedWhilePainted = page.seen.length === 2; // probe + paint, not yet cleaned
        return Buffer.from('png');
      },
      { onOutcome: (o) => (outcome = o) },
    );
    const painted = page.seen[1] ?? '';
    check('a page with a password field is obscured before the picture', painted.includes(REDACTION_MARKER_ATTR) && capturedWhilePainted);
    check('the region painted is the padded field box', painted.includes('{"x":94,"y":194,"w":252,"h":48}'));
    check('the page is put back afterwards', page.seen[2] === CLEAR_BLUR_OVERLAY_JS);
    check('the screenshot still comes back', shot.toString() === 'png');
    check('the caller is told what happened', (outcome as RedactionOutcome | null)?.fields === 1 && (outcome as RedactionOutcome | null)?.regions === 1);
  }

  {
    const page = fakePage([]);
    const shot = await withSecretFieldsHidden(page.evaluate, async () => Buffer.from('png'));
    check('a page with no password field is captured untouched', page.seen.length === 1 && page.seen[0] === SECRET_FIELD_PROBE_JS);
    check('and still yields its screenshot', shot.toString() === 'png');
  }

  {
    // A page that refuses to be inspected at all. Losing the evidence entirely
    // would be the worse trade — the browser is masking the field itself here.
    const page = fakePage(box, { refuse: true });
    const shot = await withSecretFieldsHidden(page.evaluate, async () => Buffer.from('png'));
    check('a page that refuses inspection still yields a screenshot', shot.toString() === 'png');
  }

  {
    // The capture itself blows up mid-flight: the user's page must not be left
    // with grey boxes on it.
    const page = fakePage(box);
    let threw = false;
    try {
      await withSecretFieldsHidden(page.evaluate, async () => {
        throw new Error('target detached');
      });
    } catch {
      threw = true;
    }
    check('a failed capture still surfaces as an error', threw);
    check('and the page is cleaned up anyway', page.seen[page.seen.length - 1] === CLEAR_BLUR_OVERLAY_JS);
  }
}

console.log('\n=== v110 4/4: every connection does it ===');
{
  /** Records what was sent over the browser's own debugging channel. */
  function stubTransport(boxes: unknown): { transport: CdpTransport; sent: { method: string; params: Record<string, unknown> }[] } {
    const sent: { method: string; params: Record<string, unknown> }[] = [];
    const transport: CdpTransport = {
      async send(method, params) {
        sent.push({ method, params: params as Record<string, unknown> });
        if (method === 'Runtime.evaluate') {
          const expression = String((params as Record<string, unknown>)?.expression ?? '');
          if (expression === SECRET_FIELD_PROBE_JS) return { result: { value: { boxes, docWidth: 1280, docHeight: 900 } } };
          return { result: { value: 1 } };
        }
        if (method === 'Page.captureScreenshot') return { data: Buffer.from('png').toString('base64') };
        if (method === 'Page.getLayoutMetrics') return { cssContentSize: { width: 1280, height: 900 } };
        return {};
      },
      subscribe() {
        return () => {};
      },
    };
    return { transport, sent };
  }

  const deps = {
    async navigate() {},
    async getUrl() {
      return 'https://app.example.com/login';
    },
    async detach() {},
    onCursor() {},
  };
  const box = [{ x: 100, y: 200, width: 240, height: 36 }];

  {
    const { transport, sent } = stubTransport(box);
    const browser = new LiteExtensionBrowser({ transport, ...deps });
    await browser.launch();
    sent.length = 0;
    const shot = await browser.screenshot();

    const order = sent.map((c) => (c.method === 'Runtime.evaluate' ? String(c.params.expression ?? '') : c.method));
    const paintedAt = order.findIndex((s) => s.includes(REDACTION_MARKER_ATTR) && s.includes('appendChild'));
    const capturedAt = order.indexOf('Page.captureScreenshot');
    const clearedAt = order.indexOf(CLEAR_BLUR_OVERLAY_JS);

    check('the in-browser connection obscures the field before capturing', paintedAt >= 0 && capturedAt > paintedAt);
    check('the in-browser connection puts the page back after capturing', clearedAt > capturedAt);
    check('the in-browser connection still returns the screenshot', shot.toString() === 'png');
  }

  // The remaining three connections cannot be stood up without a real browser
  // or a real socket (see docs/infra/testing.md), so they are guarded the same
  // way the rest of the fast suite guards them: the method exists, and it goes
  // through the one shared helper rather than capturing on its own.
  check('the desktop-helper connection offers a screenshot at all', typeof ExtensionBrowser.prototype.screenshot === 'function');
  for (const [label, file] of [
    ['the desktop-helper connection', 'src/ports/extension-browser.ts'],
    ['the direct connection', 'src/ports/cdp-browser.ts'],
    ['the Playwright connection', 'src/ports/playwright-browser.ts'],
  ] as const) {
    const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('async screenshot('));
    const end = body.indexOf('\n  }');
    check(`${label} routes its screenshot through the shared redaction`, body.slice(0, end).includes('withSecretFieldsHidden'));
  }

  {
    const { transport, sent } = stubTransport([]);
    const browser = new LiteExtensionBrowser({ transport, ...deps });
    await browser.launch();
    sent.length = 0;
    await browser.screenshot();
    check(
      'a page with no password field is not touched over any connection',
      !sent.some((c) => c.method === 'Runtime.evaluate' && String(c.params.expression ?? '').includes(REDACTION_MARKER_ATTR)),
    );
  }
}

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  console.error(`\n${failed.length} checks failed:`);
  for (const [label] of failed) console.error(` - ${label}`);
  process.exit(1);
}

console.log(`\nV110 password-screenshot redaction checks passed (${checks.length}).`);
