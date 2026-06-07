const cart = JSON.parse(sessionStorage.getItem('cart') || '[]');
const total = Number(sessionStorage.getItem('total') || '0');
document.getElementById('summary').textContent = cart.length + ' item(s) — total $' + total.toFixed(2);

function buildOrder() {
  return { items: cart }; // BUG: total missing → order.total is undefined
}

document.getElementById('place-order').addEventListener('click', () => {
  const order = buildOrder();
  // Show what we're charging BEFORE posting. With the bug, order.total is
  // undefined, so this line throws synchronously and the handler aborts here —
  // the order never posts and the page never reaches /success. Deterministic.
  document.getElementById('charged').textContent = 'Charged: $' + order.total.toFixed(2);
  fetch('/api/order', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(order) })
    .then(r => {
      if (r.ok) location.href = '/success';
      else {
        const e = document.getElementById('api-error');
        e.textContent = 'Order API failed with status ' + r.status;
        e.style.display = 'block';
      }
    });
});
