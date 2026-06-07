/* Ghost-cursor overlay content script — the watchable show.
 *
 * Dormant until the first chrome.runtime message with target:'qa-overlay'
 * arrives (sent by the service worker when the daemon emits a vibe.cursor
 * event). On first message it lazily builds three pieces of UI, all
 * position:fixed + pointer-events:none so they never affect page layout or
 * intercept input, and never reads page JS state:
 *
 *   - cursor : a 22px indigo dot that glides (CSS transition) to each (x,y)
 *   - caption: a bottom-center pill narrating the current step
 *   - ripple : an expanding/fading ring spawned at each click point
 *
 * The content script re-injects per page load, so navigation simply resets us
 * to dormant — which is correct.
 *
 * Message shapes (params spread into the message by the SW):
 *   { target:'qa-overlay', kind:'move', x, y, caption }
 *   { target:'qa-overlay', kind:'type', x, y, caption }
 *   { target:'qa-overlay', kind:'click', x, y }
 *   { target:'qa-overlay', kind:'caption', caption, ok? }
 */

(() => {
  'use strict';

  const CURSOR_ID = '__qa_ghost_cursor__';
  const CAPTION_ID = '__qa_ghost_caption__';
  const STYLE_ID = '__qa_ghost_style__';

  let cursorEl = null;
  let captionEl = null;
  let built = false;

  function injectStyleOnce() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '@keyframes __qa_ripple {',
      '  0%   { transform: translate(-50%, -50%) scale(0.25); opacity: 0.9; }',
      '  100% { transform: translate(-50%, -50%) scale(1);    opacity: 0; }',
      '}',
      '@keyframes __qa_press {',
      '  0%   { transform: translate(-50%, -50%) scale(1); }',
      '  50%  { transform: translate(-50%, -50%) scale(0.6); }',
      '  100% { transform: translate(-50%, -50%) scale(1); }',
      '}',
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  function build() {
    if (built && document.getElementById(CURSOR_ID) && document.getElementById(CAPTION_ID)) {
      return;
    }
    injectStyleOnce();

    cursorEl = document.getElementById(CURSOR_ID);
    if (!cursorEl) {
      cursorEl = document.createElement('div');
      cursorEl.id = CURSOR_ID;
      Object.assign(cursorEl.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        width: '22px',
        height: '22px',
        borderRadius: '50%',
        background: '#4f46e5',
        border: '2px solid #ffffff',
        boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
        // start centered on the origin; transform carries position + centering
        transform: 'translate(-50%, -50%) translate(-100px, -100px)',
        transition: 'transform 450ms cubic-bezier(.2,.7,.3,1)',
        zIndex: '2147483647',
        pointerEvents: 'none',
        boxSizing: 'border-box',
      });
      document.documentElement.appendChild(cursorEl);
    }

    captionEl = document.getElementById(CAPTION_ID);
    if (!captionEl) {
      captionEl = document.createElement('div');
      captionEl.id = CAPTION_ID;
      Object.assign(captionEl.style, {
        position: 'fixed',
        bottom: '24px',
        left: '50%',
        transform: 'translateX(-50%)',
        background: '#16161c',
        color: '#ffffff',
        font: '14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        padding: '10px 18px',
        borderRadius: '999px',
        boxShadow: '0 4px 18px rgba(0,0,0,0.35)',
        maxWidth: '70vw',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        zIndex: '2147483647',
        pointerEvents: 'none',
        opacity: '0',
        transition: 'opacity 200ms ease',
      });
      document.documentElement.appendChild(captionEl);
    }

    built = true;
  }

  function moveCursor(x, y) {
    if (!cursorEl || typeof x !== 'number' || typeof y !== 'number') return;
    // translate(-50%,-50%) centers the dot; then translate to the point.
    cursorEl.style.transform =
      'translate(-50%, -50%) translate(' + x + 'px, ' + y + 'px)';
  }

  function pressPulse() {
    if (!cursorEl) return;
    // restart the keyframe animation
    cursorEl.style.animation = 'none';
    // force reflow so the next assignment re-triggers the animation
    void cursorEl.offsetWidth;
    cursorEl.style.animation = '__qa_press 250ms ease';
  }

  function setCaption(text, ok) {
    if (!captionEl) return;
    captionEl.textContent = '';
    if (ok === true) {
      const tick = document.createElement('span');
      tick.textContent = '✓ ';
      tick.style.color = '#34d399';
      captionEl.appendChild(tick);
    } else if (ok === false) {
      const tick = document.createElement('span');
      tick.textContent = '✗ ';
      tick.style.color = '#f87171';
      captionEl.appendChild(tick);
    }
    captionEl.appendChild(document.createTextNode(text || ''));
    captionEl.style.opacity = '1';
  }

  function ripple(x, y) {
    if (typeof x !== 'number' || typeof y !== 'number') return;
    const ring = document.createElement('div');
    ring.className = '__qa_ripple_ring';
    Object.assign(ring.style, {
      position: 'fixed',
      left: x + 'px',
      top: y + 'px',
      width: '48px',
      height: '48px',
      marginLeft: '0',
      marginTop: '0',
      borderRadius: '50%',
      border: '3px solid #4f46e5',
      boxSizing: 'border-box',
      transform: 'translate(-50%, -50%) scale(0.25)',
      zIndex: '2147483646',
      pointerEvents: 'none',
      animation: '__qa_ripple 600ms ease-out forwards',
    });
    document.documentElement.appendChild(ring);
    setTimeout(() => {
      try { ring.remove(); } catch (e) { /* already gone */ }
    }, 650);
  }

  function handle(msg) {
    if (!msg || msg.target !== 'qa-overlay') return;
    build();
    switch (msg.kind) {
      case 'move':
      case 'type':
        moveCursor(msg.x, msg.y);
        if (msg.caption !== undefined) setCaption(msg.caption);
        break;
      case 'click':
        ripple(msg.x, msg.y);
        pressPulse();
        break;
      case 'caption':
        setCaption(msg.caption, msg.ok);
        break;
      default:
        break;
    }
  }

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      try { handle(msg); } catch (e) { /* overlay is cosmetic — never throw */ }
      // synchronous handler; no response needed
    });
  } catch (e) {
    /* not in an extension context — no-op */
  }
})();
