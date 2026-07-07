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
import type { AxNode, BrowserPort } from '../src/ports/browser-port.js';

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
`;

const INDEX_HTML = `<!DOCTYPE html><html><head><title>M1 shop</title></head><body>
<h1>Demo shop</h1>
<label>Coupon <input id="coupon" type="text"></label>
<label>Shipping <select id="shipping"><option value="standard">Standard</option><option value="express">Express</option></select></label>
<p id="shipping-status">Shipping: standard</p>
<button id="more">More actions</button>
<div id="hover-panel" hidden>Hover menu visible</div>
<p id="key-status">No key yet</p>
<button id="add">Add Widget</button>
<div id="total">$0.00</div>
<script src="/app.js"></script>
</body></html>`;

function findByName(node: AxNode, role: string, name: string): AxNode | undefined {
  if (node.role === role && node.name === name) return node;
  for (const c of node.children ?? []) {
    const hit = findByName(c, role, name);
    if (hit) return hit;
  }
  return undefined;
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

    await browser.selectOption(shipping!.id, 'express');
    const ax4 = await browser.axTree();
    check('selectOption() updates native select value', ax4.text.includes('Shipping: express'));

    await browser.hover(more!.id);
    const ax5 = await browser.axTree();
    check('hover() dispatches mouse movement', ax5.text.includes('Hover menu visible'));

    await browser.navigate(`http://127.0.0.1:${httpPort}/second`);
    check('navigate to second page before goBack()', (await browser.url()).includes('/second'));
    await browser.goBack();
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
