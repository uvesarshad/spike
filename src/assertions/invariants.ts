/* Tier 0 invariant oracle (A24) — assertions true of essentially every correct
 * page, requiring zero human-written expectation. Two independent surfaces:
 *
 *  - checkDrainInvariants()  — derived from console/network drains the loop
 *    already collects every step (src/capture/console-network.ts). No page
 *    evaluation, so this is free even on steps that don't screenshot.
 *  - INVARIANT_PROBE_JS / checkProbeInvariants() — an in-page probe (string
 *    literal executed via CDP Runtime.evaluate, same pattern as
 *    src/ports/runner-assets.ts) that inspects the live DOM for rendered
 *    "undefined"/"NaN"/etc, broken images, layout overflow, empty required
 *    regions, stuck loading states, and duplicate ids. checkProbeInvariants
 *    parses whatever the probe returned — the probe runs in a hostile page
 *    and may be tampered with, throw, or return junk, so parsing is fully
 *    defensive and never throws.
 *
 * (A third surface, checkAxInvariants() — a structural pass over the AX
 * snapshot flagging unlabelled interactive controls — was removed 2026-09
 * (A34): it was never called anywhere outside its own unit test, so it never
 * actually reached a real run.)
 *
 * These are deterministic and cost no model call — the highest-value primitive
 * an autonomous run can fail on, because "the AI thought it looked fine" is
 * exactly the hallucination exposure this tier removes. See
 * docs/plan/26-08-08-audit-deterministic-speed.md (A24) and
 * docs/plan/26-08-08-options-autonomy-layer.md (A24 section) for the design
 * rationale and the full tier list (this module is Tier 0 only). */

import type { ConsoleEntry, NetworkEntry } from '../ports/browser-port.js';

export interface InvariantViolation {
  rule: string; // stable kebab-case id, e.g. 'rendered-undefined'
  severity: 'error' | 'warn';
  detail: string; // one human-readable sentence
  evidence?: string; // the offending text/url, truncated & redacted
}

export interface InvariantConfig {
  disabled?: string[]; // rule ids to skip
  allowText?: string[]; // literal strings that are legitimate on this app
}

// ---- shared limits / redaction -------------------------------------------

const MAX_ITEMS_PER_RULE = 10;
const MAX_EVIDENCE_LEN = 200;

/* Minimal duplicate of src/cache/action-cache.ts's SECRET_PATTERNS /
 * redactSecretLikeText. That module is owned by another agent in this sweep,
 * so we mirror the idea locally rather than import it — keep in sync by hand
 * if the real patterns change. */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/,
];

function redactSecretLikeText(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

function truncateEvidence(text: string, max = MAX_EVIDENCE_LEN): string {
  const redacted = redactSecretLikeText(text);
  return redacted.length > max ? redacted.slice(0, max) + '…' : redacted;
}

function isDisabled(config: InvariantConfig | undefined, rule: string): boolean {
  return config?.disabled?.includes(rule) ?? false;
}

/** Per-rule bounded collector so a chatty page can't blow up the violation list. */
class Capped {
  private counts = new Map<string, number>();
  constructor(private readonly config: InvariantConfig | undefined) {}
  push(out: InvariantViolation[], v: InvariantViolation): void {
    if (isDisabled(this.config, v.rule)) return;
    const n = this.counts.get(v.rule) ?? 0;
    if (n >= MAX_ITEMS_PER_RULE) return;
    this.counts.set(v.rule, n + 1);
    out.push(v);
  }
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

const UNHANDLED_REJECTION_RE = /\(in promise\)|unhandled.*rejection/i;

// ---- Tier 0a: drain-derived invariants ------------------------------------

/** Derivable from drains + url, no page evaluation needed. */
export function checkDrainInvariants(input: {
  console: ConsoleEntry[];
  network: NetworkEntry[];
  url: string;
  config?: InvariantConfig;
}): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  const cap = new Capped(input.config);
  const targetOrigin = originOf(input.url);

  for (const entry of input.console) {
    if (entry.level === 'page-error') {
      const isRejection = UNHANDLED_REJECTION_RE.test(entry.text);
      cap.push(out, {
        rule: isRejection ? 'unhandled-rejection' : 'page-error',
        severity: 'error',
        detail: isRejection
          ? 'An unhandled promise rejection occurred on the page.'
          : 'An uncaught page error occurred.',
        evidence: truncateEvidence(entry.text),
      });
    } else if (entry.level === 'error') {
      cap.push(out, {
        rule: 'console-error',
        severity: 'error',
        detail: 'console.error was called.',
        evidence: truncateEvidence(entry.text),
      });
    }
  }

  // Same-origin only — third-party analytics/ads failing must not fail a run.
  for (const entry of input.network) {
    const entryOrigin = originOf(entry.url);
    if (!targetOrigin || !entryOrigin || entryOrigin !== targetOrigin) continue;

    if (typeof entry.status === 'number' && entry.status >= 500) {
      cap.push(out, {
        rule: 'network-error',
        severity: 'error',
        detail: `Same-origin request responded with server error ${entry.status}.`,
        evidence: truncateEvidence(`${entry.method} ${entry.url} -> ${entry.status}`),
      });
    } else if (typeof entry.status === 'number' && entry.status >= 400) {
      cap.push(out, {
        rule: 'network-error',
        severity: 'warn',
        detail: `Same-origin request responded with client error ${entry.status}.`,
        evidence: truncateEvidence(`${entry.method} ${entry.url} -> ${entry.status}`),
      });
    } else if (entry.status === undefined && entry.failed) {
      cap.push(out, {
        rule: 'network-error',
        severity: 'error',
        detail: 'Same-origin request failed to load.',
        evidence: truncateEvidence(`${entry.method} ${entry.url} -> ${entry.errorText ?? 'failed'}`),
      });
    }
  }

  return out;
}

// ---- Tier 0b: in-page probe ------------------------------------------------

/** In-page probe JS (string literal, IIFE returning a JSON-serialisable
 * object). Callers evaluate this via CDP Runtime.evaluate({ expression:
 * INVARIANT_PROBE_JS, returnByValue: true }) and pass the resulting value to
 * checkProbeInvariants(). Deliberately over-collects (caps at ~50/rule) and
 * leaves filtering (config.allowText, final cap of 10, redaction) to the Node
 * side, which is the trusted half of this boundary. Wrapped end to end in
 * try/catch so a hostile/broken page can never throw into the caller. */
export const INVARIANT_PROBE_JS = `
(function () {
  try {
    var PROBE_CAP = 50;
    var TOKEN_RE = /\\b(?:undefined|NaN|null|Infinity)\\b/;

    function isVisible(el) {
      try {
        if (!el) return false;
        if (el.closest && el.closest('[aria-hidden="true"]')) return false;
        var cs = window.getComputedStyle(el);
        if (!cs) return true;
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        if (el.offsetParent === null && cs.position !== 'fixed' && el !== document.body) return false;
        return true;
      } catch (e) {
        return false;
      }
    }

    // ---- rendered-undefined: visible text nodes only, skip script/style ----
    var renderedUndefined = [];
    try {
      var walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, null);
      var visited = 0;
      var node;
      while ((node = walker.nextNode()) && visited < 20000 && renderedUndefined.length < PROBE_CAP) {
        visited++;
        var text = node.nodeValue;
        if (!text) continue;
        var trimmed = text.trim();
        if (!trimmed) continue;
        var hasToken = TOKEN_RE.test(trimmed) || trimmed.indexOf('[object Object]') !== -1;
        if (!hasToken) continue;
        var parent = node.parentElement;
        if (!parent) continue;
        var tag = parent.tagName ? parent.tagName.toLowerCase() : '';
        if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'title') continue;
        if (!isVisible(parent)) continue;
        renderedUndefined.push(trimmed.slice(0, 300));
      }
    } catch (e) {}

    // ---- broken-image ----
    var brokenImages = [];
    try {
      var imgs = document.querySelectorAll('img[src]');
      for (var i = 0; i < imgs.length && brokenImages.length < PROBE_CAP; i++) {
        var img = imgs[i];
        if (img.complete && img.naturalWidth === 0 && img.src) {
          brokenImages.push(String(img.src).slice(0, 300));
        }
      }
    } catch (e) {}

    // ---- layout-overflow ----
    var overflow = null;
    try {
      var docEl = document.documentElement;
      if (docEl && docEl.scrollWidth > docEl.clientWidth) {
        overflow = { scrollWidth: docEl.scrollWidth, clientWidth: docEl.clientWidth };
      }
    } catch (e) {}

    // ---- empty-required-region ----
    var landmarks = { hasMain: false, hasH1: false, mainTextLength: 0 };
    try {
      var main = document.querySelector('main, [role="main"]');
      landmarks.hasMain = !!main;
      landmarks.hasH1 = !!document.querySelector('h1');
      landmarks.mainTextLength = main && main.textContent ? main.textContent.trim().length : 0;
    } catch (e) {}

    // ---- stuck-loading ----
    var stuckLoading = [];
    try {
      var candidates = document.querySelectorAll(
        '[aria-busy="true"], [role="progressbar"], [class*="skeleton" i], [class*="spinner" i], [class*="loading" i]'
      );
      for (var j = 0; j < candidates.length && stuckLoading.length < PROBE_CAP; j++) {
        var el2 = candidates[j];
        if (!isVisible(el2)) continue;
        var desc = el2.tagName ? el2.tagName.toLowerCase() : 'el';
        if (el2.id) desc += '#' + el2.id;
        else if (typeof el2.className === 'string' && el2.className.trim()) {
          desc += '.' + el2.className.trim().split(/\\s+/).slice(0, 3).join('.');
        }
        stuckLoading.push(desc.slice(0, 300));
      }
    } catch (e) {}

    // ---- duplicate-ids ----
    var duplicateIds = [];
    try {
      var seen = Object.create(null);
      var withId = document.querySelectorAll('[id]');
      for (var k = 0; k < withId.length; k++) {
        var idVal = withId[k].id;
        if (!idVal) continue;
        seen[idVal] = (seen[idVal] || 0) + 1;
      }
      for (var key in seen) {
        if (seen[key] > 1 && duplicateIds.length < PROBE_CAP) {
          duplicateIds.push({ id: String(key).slice(0, 300), count: seen[key] });
        }
      }
    } catch (e) {}

    return {
      renderedUndefined: renderedUndefined,
      brokenImages: brokenImages,
      overflow: overflow,
      landmarks: landmarks,
      stuckLoading: stuckLoading,
      duplicateIds: duplicateIds,
    };
  } catch (outerErr) {
    return { error: String((outerErr && outerErr.message) || outerErr) };
  }
})()
`;

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** Parse whatever INVARIANT_PROBE_JS returned into violations. Defensive by
 * construction: the probe runs in a hostile page and may return junk, a
 * primitive, or nothing at all (e.g. Runtime.evaluate threw upstream and the
 * caller passed the error through). Never throws. */
export function checkProbeInvariants(raw: unknown, config?: InvariantConfig): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  const cap = new Capped(config);
  const root = asRecord(raw);
  const allowText = config?.allowText ?? [];

  // rendered-undefined
  for (const item of asArray(root.renderedUndefined)) {
    if (typeof item !== 'string' || !item) continue;
    if (allowText.some((a) => typeof a === 'string' && a.length > 0 && item.includes(a))) continue;
    cap.push(out, {
      rule: 'rendered-undefined',
      severity: 'error',
      detail: 'Visible text renders a raw undefined/NaN/null/Infinity/[object Object] token.',
      evidence: truncateEvidence(item),
    });
  }

  // broken-image
  for (const src of asArray(root.brokenImages)) {
    if (typeof src !== 'string' || !src) continue;
    cap.push(out, {
      rule: 'broken-image',
      severity: 'error',
      detail: 'An <img> failed to load (naturalWidth is 0).',
      evidence: truncateEvidence(src),
    });
  }

  // layout-overflow
  const overflow = root.overflow;
  if (overflow && typeof overflow === 'object') {
    const o = overflow as Record<string, unknown>;
    const scrollWidth = typeof o.scrollWidth === 'number' ? o.scrollWidth : undefined;
    const clientWidth = typeof o.clientWidth === 'number' ? o.clientWidth : undefined;
    if (scrollWidth !== undefined && clientWidth !== undefined) {
      cap.push(out, {
        rule: 'layout-overflow',
        severity: 'warn',
        detail: 'The page has horizontal overflow beyond the viewport.',
        evidence: truncateEvidence(`scrollWidth=${scrollWidth} clientWidth=${clientWidth}`),
      });
    }
  }

  // empty-required-region — only evaluated when the probe actually reported
  // landmark data. Missing/malformed `landmarks` (e.g. the probe's outer
  // catch fired and returned an `{ error }` payload) means "we don't know",
  // not "the page has no <main>" — defaulting to a violation there would be a
  // false positive baked into every probe failure.
  const landmarksRaw = root.landmarks;
  if (landmarksRaw && typeof landmarksRaw === 'object') {
    const landmarks = landmarksRaw as Record<string, unknown>;
    const hasMain = landmarks.hasMain === true;
    const hasH1 = landmarks.hasH1 === true;
    const mainTextLength = typeof landmarks.mainTextLength === 'number' ? landmarks.mainTextLength : 0;
    if (!hasMain) {
      // Calibrated down from 'error' after the first real fixture run (2026-08-09):
      // this fired on all 7 steps of a run whose ONLY genuine defect was a
      // TypeError on the last step, drowning the real signal 12-to-2. A missing
      // <main>/<h1> is a structural/a11y smell, not evidence the app is broken —
      // plenty of correct SPA routes lack both. An empty <main>, below, IS a
      // blank-page signal and stays an error.
      cap.push(out, {
        rule: 'empty-required-region',
        severity: 'warn',
        detail: 'No <main> (or role="main") landmark found on the page.',
      });
    } else if (mainTextLength === 0) {
      cap.push(out, {
        rule: 'empty-required-region',
        severity: 'error',
        detail: 'The <main> landmark is empty of text.',
      });
    }
    if (!hasH1) {
      // Same calibration as the missing-<main> case above: a smell, not a break.
      cap.push(out, {
        rule: 'empty-required-region',
        severity: 'warn',
        detail: 'No <h1> found on the page.',
      });
    }
  }

  // stuck-loading (timing-sensitive — warn, not error)
  for (const item of asArray(root.stuckLoading)) {
    if (typeof item !== 'string' || !item) continue;
    cap.push(out, {
      rule: 'stuck-loading',
      severity: 'warn',
      detail: 'A loading/skeleton/spinner indicator is still visible.',
      evidence: truncateEvidence(item),
    });
  }

  // duplicate-ids
  for (const item of asArray(root.duplicateIds)) {
    const rec = asRecord(item);
    if (typeof rec.id !== 'string' || !rec.id) continue;
    const count = typeof rec.count === 'number' ? rec.count : undefined;
    cap.push(out, {
      rule: 'duplicate-ids',
      severity: 'error',
      detail: `DOM id "${truncateEvidence(rec.id, 80)}" is used ${count ?? 'more than'} times.`,
      evidence: truncateEvidence(rec.id),
    });
  }

  return out;
}
