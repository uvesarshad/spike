const cart = JSON.parse(sessionStorage.getItem('cart') || '[]');
const render = () => document.getElementById('cart-status').textContent = 'Cart: ' + cart.length + ' items';
document.querySelectorAll('.add').forEach(b => b.addEventListener('click', () => {
  cart.push({ name: b.dataset.name, price: Number(b.dataset.price) });
  sessionStorage.setItem('cart', JSON.stringify(cart));
  render();
}));
document.getElementById('goto-cart').addEventListener('click', () => location.href = '/cart');
render();
