/* Dogfood fixture — a small interactive shop with an intentional, toggleable bug.
 *
 * Flow: /login (test@test.com / pw) → /products (add to cart, sessionStorage)
 *       → /cart (spike B's discount logic) → /checkout → /success
 *
 * Bug mode (FIXTURE_BUG=on or startFixture(port, true)):
 *   - buildOrder() omits `total` → "Place order" throws reading order.total
 *     (the page's error listener renders the classic red "Application error"
 *     banner, echoing spike A's bad.html)
 *   - POST /api/order returns 500
 *   → one click yields [PAGE-ERROR] + failed network + a visibly broken page:
 *     exercises console, network and Nano-vision evidence paths at once.
 * Healthy mode reaches /success with a confirmation message. */

import http from 'node:http';

const STYLE = `<style>
  body{font-family:system-ui;margin:0;background:#f6f7fb;color:#16161c}
  nav{background:#16161c;color:#fff;padding:14px 28px;display:flex;gap:24px;font-size:14px}
  nav b{color:#9aa0ff}
  .wrap{max-width:720px;margin:28px auto;padding:0 20px}
  .card{background:#fff;border:1px solid #e6e7ef;border-radius:14px;padding:18px;margin-bottom:14px}
  button{background:#4f46e5;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:14px;cursor:pointer}
  input{padding:9px 12px;border:1px solid #ccd;border-radius:8px;font-size:14px;display:block;margin:6px 0 14px;width:260px}
  .error-banner{background:#ffe2e2;color:#a40000;padding:14px 20px;font-size:14px;display:none}
  .inline-error{color:#a40000;font-size:13px;display:none}
</style>`;

const NAV = `<nav><b>Acme Shop</b><span>Fixture app</span></nav>`;

const ERROR_LISTENER = `<script>
window.addEventListener('error', () => {
  const b = document.getElementById('crash-banner');
  if (b) { b.style.display = 'block'; }
});
</script>`;

function page(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><title>${title}</title>${STYLE}</head><body>
<div id="crash-banner" class="error-banner">Application error: a client-side exception has occurred (see the browser console for more information).</div>
${NAV}<div class="wrap">${body}</div>${ERROR_LISTENER}</body></html>`;
}

function pages(bug: boolean, variant: FixtureVariant = 'v1'): Record<string, string> {
  // v2 simulates UI drift for self-heal testing: same flow, the checkout
  // button is renamed — recorded scripts that click "Place order" must break
  const placeOrderLabel = variant === 'v2' ? 'Confirm purchase' : 'Place order';
  return {
    '/login': page(
      'Sign in — Acme Shop',
      `<div class="card"><h2>Sign in</h2>
      <label>Email <input id="email" type="email" autocomplete="off"></label>
      <label>Password <input id="password" type="password"></label>
      <p id="login-error" class="inline-error">Invalid email or password.</p>
      <button id="signin">Sign in</button></div>
      <script>
      document.getElementById('signin').addEventListener('click', () => {
        const ok = document.getElementById('email').value === 'test@test.com'
                && document.getElementById('password').value === 'pw';
        if (ok) location.href = '/products';
        else document.getElementById('login-error').style.display = 'block';
      });
      </script>`,
    ),

    '/products': page(
      'Products — Acme Shop',
      `<h2>Products</h2>
      <div class="card"><b>Widget</b> — $49.99 <button class="add" data-name="Widget" data-price="49.99">Add Widget to cart</button></div>
      <div class="card"><b>Gadget</b> — $25.00 <button class="add" data-name="Gadget" data-price="25.00">Add Gadget to cart</button></div>
      <p id="cart-status">Cart: 0 items</p>
      <button id="goto-cart">Go to cart</button>
      <script>
      const cart = JSON.parse(sessionStorage.getItem('cart') || '[]');
      const render = () => document.getElementById('cart-status').textContent = 'Cart: ' + cart.length + ' items';
      document.querySelectorAll('.add').forEach(b => b.addEventListener('click', () => {
        cart.push({ name: b.dataset.name, price: Number(b.dataset.price) });
        sessionStorage.setItem('cart', JSON.stringify(cart));
        render();
      }));
      document.getElementById('goto-cart').addEventListener('click', () => location.href = '/cart');
      render();
      </script>`,
    ),

    '/cart': page(
      'Cart — Acme Shop',
      `<h2>Your cart</h2>
      <div class="card"><ul id="items"></ul><p id="cart-total">Total: $0.00</p></div>
      <button id="checkout">Checkout</button>
      <script>
      const cart = JSON.parse(sessionStorage.getItem('cart') || '[]');
      const ul = document.getElementById('items');
      let total = 0;
      for (const item of cart) {
        total += item.price;
        const li = document.createElement('li');
        li.textContent = item.name + ' — $' + item.price.toFixed(2);
        ul.appendChild(li);
      }
      // spike B's silent-discount logic: 10% off at $100+
      if (total >= 100) total *= 0.9;
      sessionStorage.setItem('total', String(total));
      document.getElementById('cart-total').textContent = 'Total: $' + total.toFixed(2);
      document.getElementById('checkout').addEventListener('click', () => location.href = '/checkout');
      </script>`,
    ),

    '/checkout': page(
      'Checkout — Acme Shop',
      `<h2>Checkout</h2>
      <div class="card"><p id="summary">Loading order…</p><p id="charged"></p></div>
      <p id="api-error" class="inline-error"></p>
      <button id="place-order">${placeOrderLabel}</button>
      <script>
      const cart = JSON.parse(sessionStorage.getItem('cart') || '[]');
      const total = Number(sessionStorage.getItem('total') || '0');
      document.getElementById('summary').textContent = cart.length + ' item(s) — total $' + total.toFixed(2);
      function buildOrder() {
        ${bug
          ? `return { items: cart }; // BUG: total missing → order.total is undefined`
          : `return { items: cart, total: total };`}
      }
      document.getElementById('place-order').addEventListener('click', () => {
        const order = buildOrder();
        fetch('/api/order', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(order) })
          .then(r => {
            if (r.ok) location.href = '/success';
            else {
              const e = document.getElementById('api-error');
              e.textContent = 'Order API failed with status ' + r.status;
              e.style.display = 'block';
            }
          });
        document.getElementById('charged').textContent = 'Charged: $' + order.total.toFixed(2);
      });
      </script>`,
    ),

    '/success': page(
      'Order confirmed — Acme Shop',
      `<h2>Order confirmed 🎉</h2>
      <div class="card"><p id="confirmation">Thank you! Your order has been placed successfully.</p></div>`,
    ),
  };
}

/** Close immediately, severing Chrome's keep-alive sockets (a bare
 * server.close() waits on them forever). */
export function stopFixture(server: http.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

export type FixtureVariant = 'v1' | 'v2';

export function startFixture(port: number, bug: boolean, variant: FixtureVariant = 'v1'): http.Server {
  const routes = pages(bug, variant);
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/api/order' && req.method === 'POST') {
      res.statusCode = bug ? 500 : 200;
      res.setHeader('content-type', 'application/json');
      res.end(bug ? '{"error":"internal"}' : '{"ok":true}');
      return;
    }
    const body = routes[url] ?? routes['/login'];
    res.setHeader('content-type', 'text/html');
    res.end(body);
  });
  server.listen(port);
  return server;
}
