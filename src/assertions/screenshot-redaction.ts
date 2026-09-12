/* E15 — password fields must not be legible in a saved screenshot.
 *
 * Screenshots are written to disk on every failure, attached to the evidence
 * bundle, sent to a visual model, and shared with whoever the user forwards
 * the report to. A password field masks its own value on screen, but that is
 * the APP's choice, not ours: a "show password" toggle, a field the app builds
 * out of a plain text input, or a browser password manager's inline preview
 * all put a real secret in the picture. Anything sitting in a password field's
 * box is therefore obscured before the picture is taken.
 *
 * Doing it before the capture rather than after is what makes this work with
 * no image library at all: the page paints the blur, so the PNG that comes
 * back is already redacted and Node never has to decode a pixel. (The
 * alternative — decoding the PNG in Node to blur a rectangle — needs an image
 * codec this project does not ship and would not otherwise want.)
 *
 * Three pieces, deliberately split so the arithmetic is testable without a
 * browser:
 *   - SECRET_FIELD_PROBE_JS  — one compile-time constant, run in the page, that
 *     reports where the password fields are, in document coordinates.
 *   - parseSecretBoxes / toBlurRegions — the Node half: defensive parsing of
 *     whatever the page returned, then box → padded, rounded, clamped region.
 *   - buildBlurOverlayScript / CLEAR_BLUR_OVERLAY_JS — paint and un-paint.
 *     The painted script is built from NUMBERS ONLY (every region is checked
 *     to be finite before it is serialised), never from page- or
 *     caller-supplied text, so this stays as safe as the single constant probe
 *     BrowserPort.probeInvariants documents.
 *
 * Lives in assertions/ next to the other in-page probe constants rather than in
 * a port: all three transports (direct connection, in-browser, in-browser lite)
 * share it verbatim, exactly like INVARIANT_PROBE_JS. */

/** A password field's box, in CSS pixels, relative to the document origin
 * (i.e. scroll offsets already folded in) — the same space a full-page capture
 * clipped from 0,0 produces. */
export interface SecretBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BlurRegion = SecretBox;

/** Never obscure more than this many boxes — a page that reports hundreds is
 * either enormous or lying, and either way the overlay is not the place to
 * find out. */
const MAX_REGIONS = 24;

/** Grown by this many CSS pixels on every side. Sub-pixel layout, a focus ring
 * and a text caret all paint slightly outside the reported box. */
const DEFAULT_PADDING_PX = 6;

/** Attribute stamped on every overlay so the clean-up can find them all again
 * without holding a reference across the capture. */
export const REDACTION_MARKER_ATTR = 'data-spike-redaction';

/** In-page probe: where are the password fields? Returns document-space boxes
 * plus the document's own size, so the Node half can clamp. Wrapped end to end
 * in try/catch — a hostile or half-loaded page yields a junk-but-harmless
 * value rather than throwing into the caller. */
export const SECRET_FIELD_PROBE_JS = `
(function () {
  try {
    var CAP = ${MAX_REGIONS};
    var nodes = document.querySelectorAll(
      'input[type="password" i], input[autocomplete="current-password" i], input[autocomplete="new-password" i]'
    );
    var sx = window.scrollX || window.pageXOffset || 0;
    var sy = window.scrollY || window.pageYOffset || 0;
    var boxes = [];
    for (var i = 0; i < nodes.length && boxes.length < CAP; i++) {
      var el = nodes[i];
      try {
        var cs = window.getComputedStyle(el);
        if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) continue;
        var r = el.getBoundingClientRect();
        if (!r || r.width <= 0 || r.height <= 0) continue;
        boxes.push({ x: r.left + sx, y: r.top + sy, width: r.width, height: r.height });
      } catch (inner) {}
    }
    var doc = document.documentElement;
    return {
      boxes: boxes,
      docWidth: Math.max(doc ? doc.scrollWidth : 0, doc ? doc.clientWidth : 0),
      docHeight: Math.max(doc ? doc.scrollHeight : 0, doc ? doc.clientHeight : 0),
    };
  } catch (outerErr) {
    return { error: String((outerErr && outerErr.message) || outerErr) };
  }
})()
`;

/** Remove every overlay this module painted. Compile-time constant, and safe to
 * run when nothing was ever painted. */
export const CLEAR_BLUR_OVERLAY_JS = `
(function () {
  try {
    var nodes = document.querySelectorAll('[${REDACTION_MARKER_ATTR}]');
    for (var i = 0; i < nodes.length; i++) {
      try { nodes[i].parentNode && nodes[i].parentNode.removeChild(nodes[i]); } catch (inner) {}
    }
    return nodes.length;
  } catch (e) {
    return 0;
  }
})()
`;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** What the probe reported, once it has been forced into a shape we trust. */
export interface SecretFieldReading {
  boxes: SecretBox[];
  docWidth?: number;
  docHeight?: number;
}

/** Parse whatever SECRET_FIELD_PROBE_JS returned. The page is hostile by
 * assumption: it may return a primitive, an error payload, boxes made of
 * strings, or nothing at all. Never throws; an unreadable answer means "no
 * boxes", which is the same outcome as a page with no password field. */
export function parseSecretBoxes(raw: unknown): SecretFieldReading {
  if (!raw || typeof raw !== 'object') return { boxes: [] };
  const root = raw as Record<string, unknown>;
  const list = Array.isArray(root.boxes) ? root.boxes : [];
  const boxes: SecretBox[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const b = item as Record<string, unknown>;
    if (!finite(b.x) || !finite(b.y) || !finite(b.width) || !finite(b.height)) continue;
    if (b.width <= 0 || b.height <= 0) continue;
    boxes.push({ x: b.x, y: b.y, width: b.width, height: b.height });
    if (boxes.length >= MAX_REGIONS) break;
  }
  return {
    boxes,
    ...(finite(root.docWidth) && root.docWidth > 0 ? { docWidth: root.docWidth } : {}),
    ...(finite(root.docHeight) && root.docHeight > 0 ? { docHeight: root.docHeight } : {}),
  };
}

/** Box → the rectangle actually painted over: padded on every side, snapped
 * outwards to whole pixels, and clamped to the document so a field scrolled
 * half off the edge (or a negative coordinate from a transformed ancestor)
 * cannot produce a region that starts off-picture. Anything that clamps away
 * to nothing is dropped. Pure arithmetic — the half of this feature that can
 * be checked without a browser. */
export function toBlurRegions(
  boxes: SecretBox[],
  opts: { padding?: number; docWidth?: number; docHeight?: number } = {},
): BlurRegion[] {
  const padding = finite(opts.padding) && opts.padding >= 0 ? opts.padding : DEFAULT_PADDING_PX;
  const maxX = finite(opts.docWidth) && opts.docWidth > 0 ? opts.docWidth : Infinity;
  const maxY = finite(opts.docHeight) && opts.docHeight > 0 ? opts.docHeight : Infinity;
  const out: BlurRegion[] = [];

  for (const box of boxes) {
    if (!finite(box.x) || !finite(box.y) || !finite(box.width) || !finite(box.height)) continue;
    // A field with no area is not on screen; padding must not conjure one up.
    if (box.width <= 0 || box.height <= 0) continue;
    const left = Math.max(0, Math.floor(box.x - padding));
    const top = Math.max(0, Math.floor(box.y - padding));
    const right = Math.min(maxX, Math.ceil(box.x + box.width + padding));
    const bottom = Math.min(maxY, Math.ceil(box.y + box.height + padding));
    const width = right - left;
    const height = bottom - top;
    if (!(width > 0) || !(height > 0)) continue;
    out.push({ x: left, y: top, width, height });
    if (out.length >= MAX_REGIONS) break;
  }

  return out;
}

/** Build the script that paints the overlays. Every number is re-checked here
 * before it is serialised, so the generated source is numeric literals and
 * nothing else — no page text, no caller text, ever reaches the page as code.
 * Returns null when there is nothing worth painting. */
export function buildBlurOverlayScript(regions: BlurRegion[]): string | null {
  const safe = regions
    .filter((r) => finite(r.x) && finite(r.y) && finite(r.width) && finite(r.height) && r.width > 0 && r.height > 0)
    .slice(0, MAX_REGIONS)
    .map((r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }));
  if (!safe.length) return null;

  return `
(function () {
  try {
    var R = ${JSON.stringify(safe)};
    var host = document.documentElement || document.body;
    if (!host) return 0;
    var blurs = false;
    try {
      blurs = !!(window.CSS && CSS.supports &&
        (CSS.supports('backdrop-filter', 'blur(8px)') || CSS.supports('-webkit-backdrop-filter', 'blur(8px)')));
    } catch (e) {}
    for (var i = 0; i < R.length; i++) {
      var d = document.createElement('div');
      d.setAttribute('${REDACTION_MARKER_ATTR}', '1');
      d.style.cssText =
        'position:absolute;pointer-events:none;z-index:2147483647;border-radius:3px;' +
        'left:' + R[i].x + 'px;top:' + R[i].y + 'px;width:' + R[i].w + 'px;height:' + R[i].h + 'px;';
      if (blurs) {
        d.style.backdropFilter = 'blur(8px)';
        d.style.webkitBackdropFilter = 'blur(8px)';
        d.style.backgroundColor = 'rgba(128,128,128,0.35)';
      } else {
        // No blur support — an opaque block is a stricter redaction, not a
        // weaker one, so this fallback never leaks.
        d.style.backgroundColor = '#8a8f98';
      }
      host.appendChild(d);
    }
    return R.length;
  } catch (e) {
    return 0;
  }
})()
`;
}

/** How a screenshot was (or wasn't) redacted — returned so a caller can report
 * it honestly rather than assuming. */
export interface RedactionOutcome {
  /** Password fields the page reported. */
  fields: number;
  /** Overlays actually painted before the capture. */
  regions: number;
}

export type PageEvaluator = (expression: string) => Promise<unknown>;

/** Obscure every password field, take the picture, put the page back.
 *
 * Best-effort and non-fatal by construction: a page that refuses evaluation
 * (a strict policy, mid-navigation, a detached target) still gets its
 * screenshot — the field is masked by the browser itself in that case, and
 * losing the evidence entirely would be the worse trade. The clean-up runs in
 * a finally, so a failed capture never leaves grey boxes on the user's page.
 *
 * `onOutcome` is handed what actually happened, for callers that want to say
 * so in the report. */
export async function withSecretFieldsHidden<T>(
  evaluate: PageEvaluator,
  capture: () => Promise<T>,
  opts: { padding?: number; onOutcome?: (outcome: RedactionOutcome) => void } = {},
): Promise<T> {
  let reading: SecretFieldReading = { boxes: [] };
  try {
    reading = parseSecretBoxes(await evaluate(SECRET_FIELD_PROBE_JS));
  } catch {
    /* can't look — fall through to an unmodified capture */
  }
  if (!reading.boxes.length) {
    opts.onOutcome?.({ fields: 0, regions: 0 });
    return capture();
  }

  const regions = toBlurRegions(reading.boxes, {
    ...(opts.padding !== undefined ? { padding: opts.padding } : {}),
    ...(reading.docWidth !== undefined ? { docWidth: reading.docWidth } : {}),
    ...(reading.docHeight !== undefined ? { docHeight: reading.docHeight } : {}),
  });
  const script = buildBlurOverlayScript(regions);
  let painted = 0;
  if (script) {
    try {
      await evaluate(script);
      painted = regions.length;
    } catch {
      /* the page would not take the overlay — see the note above */
    }
  }
  opts.onOutcome?.({ fields: reading.boxes.length, regions: painted });

  try {
    return await capture();
  } finally {
    if (painted) {
      try {
        await evaluate(CLEAR_BLUR_OVERLAY_JS);
      } catch {
        /* the page is gone or navigating; the overlays went with it */
      }
    }
  }
}
