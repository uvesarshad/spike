/* Redaction — the one place that decides what a typed value looks like once it
 * leaves the browser.
 *
 * The driver itself is already correct by construction: a {{secret:NAME}}
 * placeholder is resolved at execute time only, so a vaulted password never
 * reaches a step record, the audit log, a recorded script or a prompt. This
 * module covers the OTHER case — a user who typed a real password straight into
 * the task text. That value used to survive verbatim into report.json, the
 * plain-English report, the generated test and the fix prompt people paste into
 * a third-party coding tool.
 *
 * Two rules, applied at every surface that persists or displays a run:
 *   1. text typed into a secret-looking field becomes "•••";
 *   2. a {{secret:NAME}} placeholder is NEVER touched — it is already safe, and
 *      it is what makes a recorded script replayable.
 *
 * Pure string functions, no I/O — so every caller (driver, report writer,
 * recorder, plain-English report) can share exactly one definition of "secret".
 */

/** What a redacted value is rendered as, everywhere. */
export const REDACTED = '•••';

/** A field whose role, accessible name or test id matches this is treated as
 * carrying a credential. Deliberately broad: over-redacting costs a little
 * report detail, under-redacting leaks a password into a file on disk. */
const SECRET_TARGET_RE = /password|passcode|pin|otp|token|secret|card|cvv|cvc/i;

/** {{secret:NAME}} — the safe form. Must survive redaction untouched. */
const SECRET_PLACEHOLDER_RE = /\{\{secret:[a-zA-Z0-9_-]+\}\}/g;

/** Does this target look like a credential field? Matched against the AX role,
 * the accessible name and (when known) the test id.
 *
 * Note: the accessibility snapshot the driver works from carries no `input
 * type`, so "is this a password box" is inferred from those three strings
 * rather than read from the DOM — no extra round-trip, and in practice a
 * password field is labelled or named as one. */
export function isSecretTarget(
  target: { role?: string; name?: string; testId?: string } | undefined,
): boolean {
  if (!target) return false;
  return SECRET_TARGET_RE.test(`${target.role ?? ''} ${target.name ?? ''} ${target.testId ?? ''}`);
}

/** Replace the literal parts of `text` with "•••", keeping any {{secret:NAME}}
 * placeholder exactly as written. Returns `text` unchanged when there is
 * nothing literal to hide (it is all placeholders, or it is empty). */
export function redactSecretText(text: string): string {
  if (!text) return text;
  SECRET_PLACEHOLDER_RE.lastIndex = 0;
  const placeholders = text.match(SECRET_PLACEHOLDER_RE);
  if (!placeholders) return REDACTED;
  // mixed literal + placeholder: keep the placeholders, hide everything else
  let out = '';
  let last = 0;
  SECRET_PLACEHOLDER_RE.lastIndex = 0;
  for (let m = SECRET_PLACEHOLDER_RE.exec(text); m; m = SECRET_PLACEHOLDER_RE.exec(text)) {
    if (text.slice(last, m.index).trim()) out += REDACTED;
    out += m[0];
    last = m.index + m[0].length;
  }
  if (text.slice(last).trim()) out += REDACTED;
  return out;
}

/** The typed-text rule: hide the value only when the field it went into looks
 * like a credential field. Anything else stays readable — a report that cannot
 * show what was typed into a search box is much less useful. */
export function redactTypedText(
  text: string,
  target: { role?: string; name?: string; testId?: string } | undefined,
): string {
  return isSecretTarget(target) ? redactSecretText(text) : text;
}
