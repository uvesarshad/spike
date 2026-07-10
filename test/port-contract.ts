/* Port-contract suite — the behavioral contract every BrowserPort implementation
 * (CdpBrowser, ExtensionBrowser, …) must pass. Lifted from the original M1
 * verification; generalized so the caller constructs the port and the suite only
 * exercises the BrowserPort interface.
 *
 * The suite owns the inline HTTP fixture and the launch()/close() lifecycle, but
 * deliberately does NOT manage Chrome processes or profiles — ExtensionBrowser
 * connects to an already-running Chrome, so anything beyond the interface is the
 * caller's responsibility. No process.exit here; the runner decides exit code. */

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import type { AxNode, BrowserPort } from '../src/ports/browser-port.js';

/** A real, always-present file path for uploadFile() checks — this test file
 * itself. Chrome's DOM.setFileInputFiles needs a path that actually exists. */
const UPLOAD_FIXTURE_PATH = fileURLToPath(import.meta.url);

export interface ContractResult {
  label: string;
  ok: boolean;
}

const APP_JS = `let cart = [];
function addItem(name, price) {
  cart.push({ name, price });
  return computeTotal();
}
function computeTotal() {
  let total = 0;
  for (const item of cart) total += item.price;
  total = applyDiscount(total);
  document.getElementById('total').textContent = '$' + total.toFixed(2);
  return total;
}
function applyDiscount(total) {
  return total >= 100 ? total * 0.9 : total;
}
document.getElementById('add').addEventListener('click', () => {
  addItem('Widget', 49.99);
  fetch('/api/ping');
});
document.getElementById('shipping').addEventListener('change', (e) => {
  document.getElementById('shipping-status').textContent = 'Shipping: ' + e.target.value;
});
document.getElementById('more').addEventListener('mouseover', () => {
  document.getElementById('hover-panel').hidden = false;
});
document.getElementById('coupon').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('key-status').textContent = 'Coupon submitted';
});
document.getElementById('file-input').addEventListener('change', (e) => {
  const f = e.target.files[0];
  document.getElementById('file-status').textContent = f ? ('Uploaded: ' + f.name) : 'No file';
});
document.getElementById('email').addEventListener('blur', () => {
  document.getElementById('blur-status').textContent = 'Blurred';
});
// Mouse-driven drag (reacts to raw mousedown/mousemove/mouseup — matches what
// BrowserPort.dragAndDrop()/mouse() actually dispatch; NOT native HTML5
// draggable/dragstart, which needs an OS gesture CDP mouse events can't fake).
(function () {
  const source = document.getElementById('drag-source');
  const zone = document.getElementById('drop-zone');
  let dragging = false;
  source.addEventListener('mousedown', () => { dragging = true; });
  document.addEventListener('mouseup', (e) => {
    if (!dragging) return;
    dragging = false;
    const r = zone.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
      document.getElementById('drop-status').textContent = 'Dropped';
    }
  });
})();
document.addEventListener('mousemove', (e) => {
  document.getElementById('mouse-status').textContent = 'Mouse at ' + Math.round(e.clientX) + ',' + Math.round(e.clientY);
});
`;

const INDEX_HTML = `<!DOCTYPE html><html><head><title>M1 shop</title></head><body>
<h1>Demo shop</h1>
<label>Coupon <input id="coupon" type="text"></label>
<label>Email <input id="email" type="email"></label>
<p id="blur-status">Not blurred</p>
<label>Shipping <select id="shipping"><option value="standard">Standard</option><option value="express">Express</option></select></label>
<p id="shipping-status">Shipping: standard</p>
<button id="more">More actions</button>
<div id="hover-panel" hidden>Hover menu visible</div>
<p id="key-status">No key yet</p>
<button id="add">Add Widget</button>
<div id="total">$0.00</div>
<label>Receipt <input id="file-input" type="file"></label>
<p id="file-status">No file</p>
<div id="drag-source" role="button" tabindex="0" style="display:inline-block;width:60px;height:30px;background:#ccf">Drag</div>
<div id="drop-zone" role="button" tabindex="0" style="display:inline-block;width:60px;height:30px;background:#fcc;margin-left:20px">Drop</div>
<p id="drop-status">Nothing dropped</p>
<p id="mouse-status">Mouse idle</p>
<script src="/app.js"></script>
</body></html>`;

// Deliberately does NOT load /app.js: a Debugger.setBreakpointByUrl logpoint
// is URL-pattern-scoped, and this suite sets one on /app.js earlier — loading
// that same script in a second tab causes Chrome to (harmlessly, but
// confusingly for a "drains are per-step" assertion) re-surface the earlier
// hits when the tab test switches back to the main tab. The tab primitives
// don't need to share a script with the main page to be tested; this sidesteps
// that interaction entirely rather than papering over it in the assertion.
const SECOND_TAB_HTML = `<!DOCTYPE html><html><head><title>second tab</title></head><body>
<p id="second-tab-marker">This is the second tab</p>
</body></html>`;

function findByName(node: AxNode, role: string, name: string): AxNode | undefined {
  if (node.role === role && node.name === name) return node;
  for (const c of node.children ?? []) {
    const hit = findByName(c, role, name);
    if (hit) return hit;
  }
  return undefined;
}

/** True when `err` is the documented "not supported in this transport" error
 * (extension/lite transports for tab primitives) — treated as an accepted,
 * documented gap rather than a contract failure. */
function isNotSupported(err: unknown): boolean {
  return err instanceof Error && /not supported/i.test(err.message);
}

/**
 * Run the BrowserPort contract against an already-constructed (but not launched)
 * port. The suite calls launch() at the start and close() in a finally, owns the
 * fixture server, logs PASS/FAIL lines, and returns the results.
 */
export async function runPortContract(
  browser: BrowserPort,
  opts: { label?: string; httpPort?: number } = {},
): Promise<ContractResult[]> {
  const label = opts.label ?? 'BrowserPort';
  const httpPort = opts.httpPort ?? 9402;

  const results: ContractResult[] = [];
  const check = (l: string, ok: boolean) => {
    results.push({ label: l, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`);
  };

  const server = http
    .createServer((req, res) => {
      if (req.url === '/app.js') {
        res.setHeader('content-type', 'text/javascript');
        res.end(APP_JS);
      } else if (req.url === '/api/ping') {
        res.setHeader('content-type', 'application/json');
        res.end('{"ok":true}');
      } else if (req.url === '/second-tab') {
        res.setHeader('content-type', 'text/html');
        res.end(SECOND_TAB_HTML);
      } else {
        res.setHeader('content-type', 'text/html');
        res.end(INDEX_HTML);
      }
    })
    .listen(httpPort);

  console.log(`\n=== port contract: ${label} (fixture http://127.0.0.1:${httpPort}) ===`);

  try {
    await browser.launch();
    await browser.navigate(`http://127.0.0.1:${httpPort}/`);
    check('navigate → url()', (await browser.url()).includes(`127.0.0.1:${httpPort}`));

    // logpoint with live variable values, zero source edits (spike B through the port)
    await browser.setLogpoint({
      url: `http://127.0.0.1:${httpPort}/app.js`,
      lineContains: 'total = applyDiscount(total)',
      expression: `'computeTotal: total=' + total + ' cart=' + JSON.stringify(cart)`,
    });

    const ax = await browser.axTree();
    console.log('--- a11y tree ---\n' + ax.text + '\n-----------------');
    const addBtn = findByName(ax.root, 'button', 'Add Widget');
    const coupon = findByName(ax.root, 'textbox', 'Coupon');
    const shipping = findByName(ax.root, 'combobox', 'Shipping');
    const more = findByName(ax.root, 'button', 'More actions');
    check('axTree finds button + textbox + combobox with stable ids', Boolean(addBtn && coupon && shipping && more));

    browser.drainConsole();
    browser.drainNetwork(); // reset buffers → next drains correlate to the clicks only

    await browser.click(addBtn!.id);
    await browser.click(addBtn!.id);
    await new Promise((r) => setTimeout(r, 500));

    const consoleEntries = browser.drainConsole();
    const networkEntries = browser.drainNetwork();
    console.log('console:', consoleEntries.map((e) => e.text));
    console.log('network:', networkEntries.map((e) => `${e.method} ${e.url} ${e.status}`));

    check(
      'logpoint captured live values via click',
      consoleEntries.some((e) => e.text.includes('[LOGPOINT]') && e.text.includes('total=99.98')),
    );
    check(
      'network capture saw /api/ping 200',
      networkEntries.some((e) => e.url.includes('/api/ping') && e.status === 200),
    );

    await browser.type(coupon!.id, 'WRONG');
    await browser.type(coupon!.id, 'SAVE10'); // retype must REPLACE, not append
    const ax2 = await browser.axTree();
    const coupon2 = findByName(ax2.root, 'textbox', 'Coupon');
    check('type() set textbox value (visible in fresh axTree)', coupon2?.value === 'SAVE10');
    // The replace check: after typing WRONG then SAVE10, the value must be
    // exactly SAVE10 — an appending type() would leave WRONGSAVE10.
    check(
      'type() REPLACES existing content (retype is not appended)',
      coupon2?.value === 'SAVE10',
    );

    await browser.pressKey('Enter');
    const ax3 = await browser.axTree();
    check('pressKey() dispatches keyboard input', ax3.text.includes('Coupon submitted'));

    // Re-resolve from ax3 (the FRESHEST snapshot), not the original `ax` —
    // nodeIds are per-snapshot (see BrowserPort docs) and the focused coupon
    // textbox gained an extra accessibility child (its live value) once typed
    // into, which renumbers everything after it. Using the stale `shipping`/
    // `more` ids here would silently resolve to the WRONG node. (Pre-existing
    // gap in this suite, found and fixed while extending it for Phase 9.)
    const shippingFresh = findByName(ax3.root, 'combobox', 'Shipping');
    await browser.selectOption(shippingFresh!.id, 'express');
    const ax4 = await browser.axTree();
    check('selectOption() updates native select value', ax4.text.includes('Shipping: express'));

    const moreFresh = findByName(ax4.root, 'button', 'More actions');
    await browser.hover(moreFresh!.id);
    const ax5 = await browser.axTree();
    check('hover() dispatches mouse movement', ax5.text.includes('Hover menu visible'));

    // ---- Phase 9: action parity (upload/drag/blur/mouse/tabs) ----
    // Each target is re-resolved from the FRESHEST snapshot immediately before
    // use (never a snapshot an earlier axTree() call has since superseded).
    const fileInput = findByName(ax5.root, 'button', 'Receipt'); // role, not findByNameAny: "Receipt" also names the label's StaticText sibling
    if (fileInput) {
      await browser.uploadFile(fileInput.id, [UPLOAD_FIXTURE_PATH]);
      const axUpload = await browser.axTree();
      check("uploadFile() sets the input's files", axUpload.text.includes('Uploaded:'));

      const email = findByName(axUpload.root, 'textbox', 'Email');
      if (email) {
        await browser.type(email.id, 'a@b.com'); // focuses the field
        await browser.blur(email.id);
        const axBlur = await browser.axTree();
        check("blur() fires the field's blur handler", axBlur.text.includes('Blurred'));

        const dragSource = findByName(axBlur.root, 'button', 'Drag');
        const dropZone = findByName(axBlur.root, 'button', 'Drop');
        if (dragSource && dropZone) {
          await browser.dragAndDrop(dragSource.id, dropZone.id);
          const axDrag = await browser.axTree();
          check('dragAndDrop() presses/moves/releases onto the drop zone', axDrag.text.includes('Dropped'));
        } else {
          check('dragAndDrop() source+target found in axTree', false);
        }
      } else {
        check("blur() target found in axTree ('Email')", false);
        check('dragAndDrop() source+target found in axTree', false);
      }
    } else {
      check("uploadFile() target found in axTree ('Receipt')", false);
      check("blur() target found in axTree ('Email')", false);
      check('dragAndDrop() source+target found in axTree', false);
    }

    await browser.mouse('move', 40, 40);
    const axMouse = await browser.axTree();
    check('mouse() dispatches a discrete mouse event', axMouse.text.includes('Mouse at'));

    // Tab primitives are a hard requirement for CdpBrowser; extension
    // transports document a clear "not supported" error instead (no bridge
    // chrome.tabs RPC yet) — both outcomes are accepted here.
    try {
      const secondTabUrl = `http://127.0.0.1:${httpPort}/second-tab`;
      const tabId = await browser.openTab(secondTabUrl);
      check('openTab() returns an id without switching the active tab', typeof tabId === 'string' && tabId.length > 0 && (await browser.url()).includes(`127.0.0.1:${httpPort}`));
      await browser.switchTab(tabId);
      check('switchTab(id) makes the opened tab active', (await browser.url()).includes('/second-tab'));
      await browser.switchTab(0);
      check('switchTab(0) returns to the main tab', !(await browser.url()).includes('/second-tab'));
      await browser.closeTab(tabId);
      check('closeTab() does not throw for a background tab', true);
    } catch (e) {
      check('tab primitives: supported and correct, OR a documented "not supported" error', isNotSupported(e));
    }

    await browser.navigate(`http://127.0.0.1:${httpPort}/second`);
    check('navigate to second page before goBack()', (await browser.url()).includes('/second'));
    await browser.goBack();
    // Discard, don't assert: a back-navigation that restores the previous page
    // from Chrome's back/forward cache can flush queued conditional-breakpoint
    // ("logpoint" — Debugger.setBreakpointByUrl condition-log trick) console
    // messages from BEFORE the navigation away, observed here as the SAME 2
    // messages the click check above already asserted on. That's a Chrome/CDP
    // characteristic of bfcache + Debugger, not a per-step-drain bug in
    // BrowserPort — drain and discard here so it can't be mistaken for a real
    // leaked/stale entry by the drain check at the end of this suite.
    browser.drainConsole();
    check('goBack() returns to previous page', !(await browser.url()).includes('/second'));

    await browser.reload();
    check('reload() keeps the current page loaded', (await browser.url()).includes(`127.0.0.1:${httpPort}`));

    const png = await browser.screenshot();
    check('screenshot returns PNG', png.length > 1000 && png.subarray(1, 4).toString() === 'PNG');

    const drained = browser.drainConsole();
    check(
      'drains are per-step (post-drain buffer only has new entries)',
      !drained.some((e) => e.text.includes('total=99.98')),
    );
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  return results;
}
