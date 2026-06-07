/* Ghost-cursor overlay content script — the watchable show.
 *
 * Dormant until the first chrome.runtime message with target:'qa-overlay'
 * arrives (sent by the service worker when the daemon emits a vibe.cursor
 * event). On first message it lazily builds the UI, all position:fixed +
 * pointer-events:none so they never affect page layout or intercept input, and
 * never reads page JS state:
 *
 *   - cursor   : a real desktop-mouse ARROW (inline SVG, white fill + dark
 *                outline + soft drop shadow, ~24px) whose TIP (hotspot) lands
 *                on the target (x,y). Glides via CSS transition, "presses" on
 *                click, and spawns ripples.
 *   - caption  : a bottom-center pill narrating the current step.
 *   - badge    : a top-center "🤖 Agent is working — controls are disabled"
 *                dark pill.
 *   - glow     : a full-viewport green inset glow with a slow breathing pulse.
 *
 * The agent-working chrome (badge + glow) appears on the FIRST overlay message
 * of a run and clears on { target:'qa-overlay', kind:'end' } (sent by the SW
 * when the run finishes), and self-clears after 3 minutes of no messages as a
 * safety net.
 *
 * The content script re-injects per page load, so navigation simply resets us
 * to dormant — which is correct.
 *
 * Message shapes (params spread into the message by the SW):
 *   { target:'qa-overlay', kind:'move', x, y, caption }
 *   { target:'qa-overlay', kind:'type', x, y, caption }
 *   { target:'qa-overlay', kind:'click', x, y }
 *   { target:'qa-overlay', kind:'caption', caption, ok? }
 *   { target:'qa-overlay', kind:'end' }
 */

(() => {
  'use strict';

  const CURSOR_ID = '__qa_ghost_cursor__';
  const CAPTION_ID = '__qa_ghost_caption__';
  const BADGE_ID = '__qa_agent_badge__';
  const GLOW_ID = '__qa_agent_glow__';
  const STYLE_ID = '__qa_ghost_style__';

  // The arrow SVG is drawn so the tip of the arrow sits at the SVG's (0,0)
  // origin. We center the cursor element on the target with translate then
  // shift nothing further — because the hotspot is the top-left (0,0) corner,
  // we anchor the element's top-left exactly at (x,y).
  const CURSOR_W = 24;
  const CURSOR_H = 24;

  let cursorEl = null;
  let captionEl = null;
  let badgeEl = null;
  let glowEl = null;
  let built = false;

  // agent-working state + safety auto-clear
  let agentActive = false;
  let safetyTimer = null;
  const SAFETY_MS = 3 * 60 * 1000;

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
      // press pulse keeps the arrow tip anchored at (0,0); scale about the tip.
      '  0%   { transform: scale(1); }',
      '  50%  { transform: scale(0.78); }',
      '  100% { transform: scale(1); }',
      '}',
      '@keyframes __qa_breathe {',
      '  0%   { box-shadow: inset 0 0 36px 6px rgba(34,197,94,0.28); }',
      '  50%  { box-shadow: inset 0 0 48px 10px rgba(34,197,94,0.40); }',
      '  100% { box-shadow: inset 0 0 36px 6px rgba(34,197,94,0.28); }',
      '}',
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  function build() {
    if (
      built &&
      document.getElementById(CURSOR_ID) &&
      document.getElementById(CAPTION_ID)
    ) {
      return;
    }
    injectStyleOnce();

    cursorEl = document.getElementById(CURSOR_ID);
    if (!cursorEl) {
      cursorEl = document.createElement('div');
      cursorEl.id = CURSOR_ID;
      // The inner SVG is a classic mouse arrow: tip at (0,0), white fill, dark
      // outline, soft drop shadow. The drop-shadow filter is applied to the
      // SVG so it follows the arrow silhouette (not a box).
      cursorEl.innerHTML =
        '<svg width="' + CURSOR_W + '" height="' + CURSOR_H + '" viewBox="0 0 24 24" ' +
        'xmlns="http://www.w3.org/2000/svg" ' +
        'style="display:block;filter:drop-shadow(0 2px 3px rgba(0,0,0,0.45));">' +
        '<path d="M2 1.5 L2 18.5 L6.4 14.4 L9.3 21.2 L12.1 20 L9.2 13.3 L15 13.3 Z" ' +
        'fill="#ffffff" stroke="#1c1c22" stroke-width="1.4" stroke-linejoin="round"/>' +
        '</svg>';
      Object.assign(cursorEl.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        width: CURSOR_W + 'px',
        height: CURSOR_H + 'px',
        // hotspot is the arrow TIP at SVG (0,0) == element top-left, so we
        // place the element top-left exactly on the target point. Start it
        // off-screen until the first move.
        transform: 'translate(-100px, -100px)',
        transition: 'transform 450ms cubic-bezier(.2,.7,.3,1)',
        transformOrigin: '0 0',
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

  /** Build (idempotent) and show the top badge + green breathing edge glow. */
  function showAgentChrome() {
    injectStyleOnce();

    badgeEl = document.getElementById(BADGE_ID);
    if (!badgeEl) {
      badgeEl = document.createElement('div');
      badgeEl.id = BADGE_ID;
      badgeEl.textContent = '🤖 Agent is working — controls are disabled';
      Object.assign(badgeEl.style, {
        position: 'fixed',
        top: '14px',
        left: '50%',
        transform: 'translateX(-50%)',
        background: '#16161c',
        color: '#ffffff',
        font: '600 13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        padding: '9px 16px',
        borderRadius: '999px',
        boxShadow: '0 4px 18px rgba(0,0,0,0.35)',
        maxWidth: '80vw',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        zIndex: '2147483647',
        pointerEvents: 'none',
      });
      document.documentElement.appendChild(badgeEl);
    }

    glowEl = document.getElementById(GLOW_ID);
    if (!glowEl) {
      glowEl = document.createElement('div');
      glowEl.id = GLOW_ID;
      Object.assign(glowEl.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        right: '0',
        bottom: '0',
        width: '100vw',
        height: '100vh',
        pointerEvents: 'none',
        zIndex: '2147483646',
        boxShadow: 'inset 0 0 48px 10px rgba(34,197,94,0.40)',
        animation: '__qa_breathe 2.6s ease-in-out infinite',
      });
      document.documentElement.appendChild(glowEl);
    }
  }

  function hideAgentChrome() {
    for (const id of [BADGE_ID, GLOW_ID]) {
      const el = document.getElementById(id);
      if (el) {
        try { el.remove(); } catch (e) { /* already gone */ }
      }
    }
    badgeEl = null;
    glowEl = null;
    if (captionEl) captionEl.style.opacity = '0';
  }

  /** Mark a run as active (idempotent) and (re)arm the 3-min safety clear. */
  function markActivity() {
    if (!agentActive) {
      agentActive = true;
      showAgentChrome();
    }
    if (safetyTimer) clearTimeout(safetyTimer);
    safetyTimer = setTimeout(endRun, SAFETY_MS);
  }

  function endRun() {
    agentActive = false;
    if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
    hideAgentChrome();
  }

  function moveCursor(x, y) {
    if (!cursorEl || typeof x !== 'number' || typeof y !== 'number') return;
    // hotspot is the arrow tip (element top-left); place top-left on (x,y).
    cursorEl.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
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
      border: '3px solid #22c55e',
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

    // 'end' tears down the agent chrome (and is NOT itself activity).
    if (msg.kind === 'end') {
      endRun();
      return;
    }

    build();
    // any non-end overlay message means a run is driving this tab.
    markActivity();

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
