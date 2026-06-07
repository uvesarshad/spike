/* M1 verification — CdpBrowser end to end against a local fixture:
 * navigate, axTree (stable ids), click via nodeId, type via nodeId,
 * screenshot, CDP logpoint with live variable values, per-step
 * console/network drains. Exits nonzero on any failure. */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CdpBrowser } from '../src/ports/cdp-browser.js';
import type { AxNode } from '../src/ports/browser-port.js';

const HTTP_PORT = 9402; // scratch port, not the daemon's
const CDP_PORT = 9323; // throwaway headless chrome, not the daemon's 9322

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

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
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
  .listen(HTTP_PORT);

const browser = new CdpBrowser({
  port: CDP_PORT,
  profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'qa-m1-')),
  headless: true,
});

try {
  await browser.launch();
  await browser.navigate(`http://127.0.0.1:${HTTP_PORT}/`);
  check('navigate → url()', (await browser.url()).includes(`127.0.0.1:${HTTP_PORT}`));

  // logpoint with live variable values, zero source edits (spike B through the port)
  await browser.setLogpoint({
    url: `http://127.0.0.1:${HTTP_PORT}/app.js`,
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
  check('drains are per-step (post-drain buffer only has new entries)', !drained.some((e) => e.text.includes('total=99.98')));
} finally {
  await browser.close();
  server.close();
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
