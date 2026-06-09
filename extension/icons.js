/* Inline SVG icon set for the side panel.
 *
 * Line icons (Lucide geometry), 24×24 viewBox, stroke=currentColor — so each
 * icon takes the color of whatever context it sits in (lime ticks, red X's,
 * muted labels) with no per-icon styling. Sizing is driven by CSS (.ico-svg).
 *
 * Usage:
 *   qaIcon('check')                         -> SVG markup string (for innerHTML)
 *   <span class="ico" data-icon="lock">     -> auto-hydrated on DOMContentLoaded
 *   qaHydrateIcons(rootEl)                   -> hydrate [data-icon] under a root
 *
 * Exposed on window so the plain (module-less) panel.js can use it.
 */
(function () {
  // inner markup only (paths/shapes); wrapped by svg() below.
  const PATHS = {
    // step kinds
    plan: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
    click: '<path d="M14 4.1 12 6"/><path d="m5.1 8-2.9-.8"/><path d="m6 12-1.9 2"/><path d="M7.2 2.2 8 5.1"/><path d="M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z"/>',
    type: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.01"/><path d="M10 8h.01"/><path d="M14 8h.01"/><path d="M18 8h.01"/><path d="M8 12h.01"/><path d="M12 12h.01"/><path d="M16 12h.01"/><path d="M7 16h10"/>',
    navigate: '<circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z"/>',
    assert: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
    wait: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    finish: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',

    // verdicts
    pass: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    fail: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
    uncertain: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',

    // states / inline
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',

    // tab + suggestions + actions
    globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    cart: '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',

    // misc ui
    chevron: '<path d="m9 18 6-6-6-6"/>',

    // generic fallback
    dot: '<circle cx="12" cy="12" r="3"/>',
  };

  function qaIcon(name) {
    const inner = PATHS[name] || PATHS.dot;
    return '<svg class="ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
      + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + inner + '</svg>';
  }

  /** Return a detached SVG element (for appendChild contexts). */
  function qaIconNode(name) {
    const tpl = document.createElement('template');
    tpl.innerHTML = qaIcon(name);
    return tpl.content.firstChild;
  }

  /** Fill every [data-icon] placeholder under root with its icon. */
  function qaHydrateIcons(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-icon]').forEach((el) => {
      el.innerHTML = qaIcon(el.getAttribute('data-icon'));
    });
  }

  window.qaIcon = qaIcon;
  window.qaIconNode = qaIconNode;
  window.qaHydrateIcons = qaHydrateIcons;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => qaHydrateIcons());
  } else {
    qaHydrateIcons();
  }
})();
