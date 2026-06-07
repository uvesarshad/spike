const cart = JSON.parse(sessionStorage.getItem('cart') || '[]');
const ul = document.getElementById('items');
let total = 0;
for (const item of cart) {
  total += item.price;
  const li = document.createElement('li');
  li.textContent = item.name + ' — $' + item.price.toFixed(2);
  ul.appendChild(li);
}
sessionStorage.setItem('total', String(total));
document.getElementById('cart-total').textContent = 'Total: $' + total.toFixed(2);
document.getElementById('checkout').addEventListener('click', () => location.href = '/checkout');
