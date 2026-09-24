/* A13: `spike check --try-controls` — what the check may press.
 *
 * A plain check only looks. With --try-controls (trusted named target only) each
 * page's visit may also press ordinary controls so a button that does nothing
 * or a form that swallows its submit can show up. Anything that could cost
 * money, remove data or leave the account is never pressed, and a form with a
 * password or payment field is never submitted. */

/** Labels that are never pressed. */
export const CONTROL_DENY_RE = /buy|pay|checkout|place order|delete|remove|cancel|unsubscribe|log ?out|sign ?out|transfer|send/i;

/** Field names that make a form off-limits to submit. */
export const SENSITIVE_FIELD_RE = /password|passcode|card|cvv|cvc|expiry|iban|routing number|account number|security code/i;

export function isSafeControlLabel(label: string): boolean {
  return !CONTROL_DENY_RE.test(label);
}

export interface TryControl {
  label: string;
  /** Names of the fields in the form this control belongs to, when it is a submit. */
  formFields?: string[];
}

export function isSafeControl(c: TryControl): boolean {
  if (!isSafeControlLabel(c.label)) return false;
  if (c.formFields?.some((f) => SENSITIVE_FIELD_RE.test(f))) return false;
  return true;
}

export function filterSafeControls<T extends TryControl>(controls: T[]): T[] {
  return controls.filter(isSafeControl);
}

/** The words one page's visit is given when controls may be pressed. */
export function tryControlsInstruction(address: string): string {
  return (
    `Open ${address} and look at it, then press the ordinary buttons and links on it one at a time to see that each does something. ` +
    `Never press anything whose label matches ${CONTROL_DENY_RE.source} (spend, delete, cancel, sign out, send), ` +
    'and never submit a form that has a password or payment field. Do not type real personal data. ' +
    'Report a problem if the page fails to load, shows an error, or a control does nothing or breaks the page. If it all works, say so.'
  );
}

/** True when a finished run pressed something it should not have — the run is
 * then not saved as a test. Reads the recorded steps (label of each click). */
export function pressedForbiddenControl(steps: { action?: { type?: string }; target?: { name?: string } }[] | undefined): boolean {
  return (steps ?? []).some((s) => s.action?.type === 'click' && !isSafeControlLabel(s.target?.name ?? ''));
}

/** Add saved tests to spike.suite.json tagged `check` (creating it from the
 * current scripts when absent, so `spike suite` keeps running everything). */
export async function tagCheckScripts(scripts: string[], root = process.cwd()): Promise<void> {
  if (!scripts.length) return;
  const fs = await import('node:fs');
  const { suiteConfigPath, resolveSuite } = await import('../suite/config.js');
  const suite = resolveSuite(root);
  const byScript = new Map(suite.entries.map((e) => [e.script, e]));
  for (const s of scripts) {
    const e = byScript.get(s) ?? { script: s };
    const tags = new Set(e.tags ?? []);
    tags.add('check');
    byScript.set(s, { ...e, tags: [...tags] });
  }
  fs.writeFileSync(suiteConfigPath(root), JSON.stringify({ ...suite, entries: [...byScript.values()] }, null, 2) + '\n');
}
