document.getElementById('signin').addEventListener('click', () => {
  const ok = document.getElementById('email').value === 'test@test.com'
          && document.getElementById('password').value === 'pw';
  if (ok) location.href = '/products';
  else document.getElementById('login-error').style.display = 'block';
});
