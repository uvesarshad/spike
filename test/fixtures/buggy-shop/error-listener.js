// Renders the classic red "Application error" banner on any uncaught error,
// mirroring the in-memory fixture's behaviour so Nano-vision sees a broken page.
window.addEventListener('error', () => {
  const b = document.getElementById('crash-banner');
  if (b) { b.style.display = 'block'; }
});
