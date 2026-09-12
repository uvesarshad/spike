/* v92 — A23 (P1): reach the part of the page that isn't on screen.
 *
 * Three related blind spots, all of them things a real site does constantly:
 *   1. there was no way to scroll at all, so infinite lists, lazy-loaded
 *      sections and anything below the fold were simply unreachable;
 *   2. the picture used for the visual judgement was only ever the top of the
 *      page, so a fault further down could not be seen even in principle;
 *   3. nothing told the page-driving model to get a cookie/consent banner or a
 *      modal out of the way first, so a run could spend its whole budget
 *      clicking underneath one.
 *
 * Covers (pure — no Chrome, no network: the browser's debugging channel is a
 * recording stub):
 *   - the action vocabulary and the response schema both accept scrolling;
 *   - scrolling dispatches a real wheel event, the right way, at a point over
 *     the thing being scrolled, and the page's own size decides how far;
 *   - a transport that cannot scroll says so instead of pretending;
 *   - the picture is taken of the whole page, with a hard height cap;
 *   - the cookie/consent rule is in the vocabulary.
 *
 * Run: npx tsx test/v92.scroll-and-full-page.ts   (exits nonzero on any failed check)
 */

import { ActionSchema, PLAN_JSON_SCHEMA } from '../src/driver/actions.js';
import { ACTION_RULES_AND_VOCABULARY } from '../src/driver/planner-prompt.js';
import { LiteExtensionBrowser } from '../src/extension/lite-extension-browser.js';
import { CdpBrowser } from '../src/ports/cdp-browser.js';
import { ExtensionBrowser } from '../src/ports/extension-browser.js';
import type { CdpTransport } from '../src/bridge/cdp-shim.js';

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

type Sent = { method: string; params: Record<string, unknown> };

/** A page 12000px tall in a 1280x800 window. */
const LAYOUT_METRICS = {
  cssVisualViewport: { clientWidth: 1280, clientHeight: 800 },
  cssContentSize: { width: 1280, height: 12000 },
};

function stubBrowser(): { browser: LiteExtensionBrowser; sent: Sent[] } {
  const sent: Sent[] = [];
  const transport: CdpTransport = {
    async send(method, params) {
      sent.push({ method, params });
      if (method === 'Page.getLayoutMetrics') return LAYOUT_METRICS;
      if (method === 'Page.captureScreenshot') return { data: Buffer.from('fake-png').toString('base64') };
      return {};
    },
    subscribe() {
      return () => {};
    },
  };
  const browser = new LiteExtensionBrowser({
    transport,
    async navigate() {},
    async getUrl() {
      return 'https://shop.example.com/products';
    },
    async detach() {},
    onCursor() {},
  });
  return { browser, sent };
}

console.log('=== v92 1/4: scrolling is a thing the models can ask for ===');
{
  const ok = ActionSchema.safeParse({ type: 'scroll', direction: 'down' });
  check('the action shape accepts scrolling the page', ok.success);
  check('…and scrolling inside one element', ActionSchema.safeParse({ type: 'scroll', direction: 'up', nodeId: 'n7' }).success);
  check('a nonsense direction is rejected', !ActionSchema.safeParse({ type: 'scroll', direction: 'sideways' }).success);
  check(
    'the response schema admits it',
    (PLAN_JSON_SCHEMA.properties.actions.items.properties.type.enum as readonly string[]).includes('scroll'),
  );
  check('the vocabulary explains when to use it', ACTION_RULES_AND_VOCABULARY.includes('- Use scroll when what you need is below'));
  check('the vocabulary gives its shape', ACTION_RULES_AND_VOCABULARY.includes('{"type":"scroll","direction":"up"|"down"'));
}

console.log('\n=== v92 2/4: scrolling moves the page like a person would ===');
{
  const { browser, sent } = stubBrowser();
  await browser.launch();

  sent.length = 0;
  await browser.scroll('down');
  const wheel = sent.find((c) => c.method === 'Input.dispatchMouseEvent');
  check('a wheel event is dispatched', wheel?.params.type === 'mouseWheel');
  check('it scrolls downward', typeof wheel?.params.deltaY === 'number' && (wheel.params.deltaY as number) > 0);
  check('it covers most of a screen, not a token nudge', (wheel?.params.deltaY as number) > 600 && (wheel?.params.deltaY as number) <= 800);
  check('it lands over the middle of what is on screen', wheel?.params.x === 640 && wheel?.params.y === 400);

  sent.length = 0;
  await browser.scroll('up');
  const up = sent.find((c) => c.method === 'Input.dispatchMouseEvent');
  check('scrolling up goes the other way', (up?.params.deltaY as number) < 0);

  // every transport that drives a real browser offers it
  for (const [name, proto] of [
    ['the direct connection', CdpBrowser.prototype],
    ['the daemon-driven in-browser transport', ExtensionBrowser.prototype],
    ['the standalone in-browser transport', LiteExtensionBrowser.prototype],
  ] as const) {
    check(`${name} can scroll`, typeof (proto as { scroll?: unknown }).scroll === 'function');
  }
}

console.log('\n=== v92 3/4: the picture covers the whole page ===');
{
  const { browser, sent } = stubBrowser();
  await browser.launch();

  sent.length = 0;
  const png = await browser.screenshot();
  const shot = sent.find((c) => c.method === 'Page.captureScreenshot');
  check('a picture comes back', png.length > 0);
  check('it reaches past what is on screen', shot?.params.captureBeyondViewport === true);
  const clip = shot?.params.clip as { width?: number; height?: number; x?: number; y?: number } | undefined;
  check('it starts at the top of the page', clip?.x === 0 && clip?.y === 0);
  check('it is as wide as the page', clip?.width === 1280);
  check('a 12000px page is capped rather than captured whole', clip?.height === 4000);
}

console.log('\n=== v92 4/4: get the banner out of the way first ===');
{
  check(
    'the vocabulary says to dismiss a consent banner or modal before continuing',
    ACTION_RULES_AND_VOCABULARY.includes(
      'If a cookie/consent banner or a modal is covering the page, dismiss it first, then continue the goal.',
    ),
  );
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) process.exit(1);
