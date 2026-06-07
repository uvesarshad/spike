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
`;

const INDEX_HTML = `<!DOCTYPE html><html><head><title>M1 shop</title></head><body>
<h1>Demo shop</h1>
<label>Coupon <input id="coupon" type="text"></label>
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
    check('axTree finds button + textbox with stable ids', Boolean(addBtn && coupon));

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

    await browser.type(coupon!.id, 'SAVE10');
    const ax2 = await browser.axTree();
    const coupon2 = findByName(ax2.root, 'textbox', 'Coupon');
    check('type() set textbox value (visible in fresh axTree)', coupon2?.value === 'SAVE10');

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
