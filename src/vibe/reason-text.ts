/* A14 (P1) — the reason translation layer.
 *
 * When a run doesn't settle, the sentence the user reads is whatever string
 * the driver happened to set. Those strings were written for whoever was
 * debugging the driver: "step budget exhausted before the task completed",
 * "goal transitions (31) exceeded the bound (36) — the navigator kept
 * completing goals without the run settling", "read-only mode: accounts.x.com
 * is not in allowedHosts — add it via SPIKE_ALLOWED_HOSTS or spike.config.json".
 * A provider failure was even worse: `anthropic api 401: {"type":"error",…}`
 * truncated into a step row and then into the verdict.
 *
 * Two things were missing, and they are the two things the reader needs:
 *
 *   1. WHOSE FAULT IS IT? "Your app is broken", "the test couldn't do it" and
 *      "your setup is wrong" demand completely different responses, and none of
 *      those strings distinguished them. Someone whose AI key had expired was
 *      shown what looked like a bug report about their own app.
 *   2. WHAT DO I DO NOW? Half the strings named an environment variable or a
 *      config file that a person driving the browser panel has no access to.
 *
 * So: one table, keyed on the reason strings the driver actually produces,
 * mapping each to a plain headline, an attribution, and a next step. Pure —
 * no imports, no I/O — so both the desktop helper and the browser-only bundle
 * use the same one, and so the table can be tested for completeness.
 *
 * Adding a new `uncertain` reason to src/driver/loop.ts means adding a rule
 * here; test/v96 walks loop.ts and fails if a reason has no rule.
 */

/** Who the reader should go and look at. Deliberately three, not more:
 * anything else is a distinction the reader cannot act on differently. */
export type WhoseFault = 'your app' | 'the test' | 'setup';

export interface ReasonExplanation {
  /** Stable id — the test table and any future telemetry key on this. */
  id: string;
  /** One sentence, in the reader's words, saying what happened. */
  headline: string;
  /** Where the problem lives. */
  whoseFault: WhoseFault;
  /** The single most useful next action. */
  nextStep: string;
}

interface ReasonRule extends ReasonExplanation {
  /** Matches the raw reason the driver produced. */
  match: RegExp;
}

/** A14: the whole table. Order matters only where two patterns could both
 * match; the first match wins, so the specific rules come before the loose
 * ones. Every entry must have a non-empty headline and nextStep. */
export const REASON_RULES: readonly ReasonRule[] = [
  {
    id: 'cancelled',
    match: /^cancelled by user$/i,
    headline: 'You stopped the test before it finished.',
    whoseFault: 'the test',
    nextStep: 'Run it again when you are ready.',
  },
  {
    id: 'key-rejected',
    // "anthropic api 401: …", "gpt api 403: …", "…status 401:…"
    match: /\b(?:api|status|http|code)\b[^\d]{0,24}(?:401|403)\s*:/i,
    headline: 'Your AI key was rejected — check it in Settings.',
    whoseFault: 'setup',
    nextStep: 'Open Settings and paste the key again, or paste a new one.',
  },
  {
    id: 'rate-limited',
    match: /\b(?:api|status|http|code)\b[^\d]{0,24}(?:429|503)\s*:/i,
    headline: 'Your AI provider is rate-limiting — wait a minute or use a different key.',
    whoseFault: 'setup',
    nextStep: 'Wait a minute and run it again, or switch to a key from another provider in Settings.',
  },
  {
    id: 'host-blocked',
    // Both the current wording and the pre-A14 "read-only mode: … allowedHosts"
    // one, so an old saved report still translates.
    match: /^blocked host:|is not on this run's allowed host list|is not in allowedHosts/i,
    headline: 'The test stopped at a page on a different website.',
    whoseFault: 'the test',
    nextStep: "Allow that website and run again if you trust it — otherwise test the part of your app that doesn't leave this site.",
  },
  {
    id: 'sso-popup',
    match: /sign-in popups aren't supported yet/i,
    headline: 'This sign-in opens a separate window, which the test can’t follow.',
    whoseFault: 'the test',
    nextStep: 'Sign in yourself on this tab first, then run the test again.',
  },
  {
    id: 'spend-cap',
    match: /^spend cap reached/i,
    headline: 'The test stopped because it hit the spending limit you set.',
    whoseFault: 'setup',
    nextStep: 'Raise the limit in Settings, or give the test a smaller job.',
  },
  {
    id: 'step-budget',
    match: /^step budget exhausted/i,
    headline: 'The test ran out of room before it got to the end.',
    whoseFault: 'the test',
    nextStep: 'Ask for one thing at a time — split this into smaller tests, or paste your document and let me split it for you.',
  },
  {
    id: 'goal-transitions',
    match: /^goal transitions \(/i,
    headline: 'The test kept ticking things off without ever reaching the end.',
    whoseFault: 'the test',
    nextStep: 'Describe what "done" looks like ("…and the confirmation page shows the order number") so it knows when to stop.',
  },
  {
    id: 'no-goals',
    match: /^planner returned no goals to execute$/i,
    headline: "I couldn't work out any steps from what you asked for.",
    whoseFault: 'the test',
    nextStep: 'Say what to do and what should happen, in one or two sentences.',
  },
  {
    id: 'no-new-plan',
    match: /the planner offered no new plan/i,
    headline: 'The test got stuck and could not find another way forward.',
    whoseFault: 'your app',
    nextStep: 'Look at the last step below — that is where it stopped making progress on the page.',
  },
  {
    id: 'stuck-no-planner',
    match: /could not recover without a planner/i,
    headline: 'The test got stuck, and there is no model set up to re-plan when that happens.',
    whoseFault: 'setup',
    nextStep: 'Set a model that plans in Settings so it can work out a new route when it gets stuck.',
  },
  {
    id: 'stuck-planner',
    match: /the planner could not recover/i,
    headline: 'The test got stuck and could not get moving again, even after re-planning.',
    whoseFault: 'your app',
    nextStep: 'Look at the last step below — that is where the page stopped responding as expected.',
  },
  {
    id: 'planner-error',
    match: /^planner failed while recovering/i,
    headline: 'The model that plans failed partway through.',
    whoseFault: 'setup',
    nextStep: 'Check your AI key in Settings, then run the test again.',
  },
  {
    id: 'confirm-failed',
    match: /^could not confirm success:/i,
    headline: 'The test thought it was done but could not check the final page.',
    whoseFault: 'the test',
    nextStep: 'Run it again; if it keeps happening, say what the last page should show.',
  },
  {
    id: 'visual-disagrees',
    match: /^navigator declared success but the confirmation visual was/i,
    headline: "The test thought it was finished, but the final page didn't look right.",
    whoseFault: 'your app',
    nextStep: 'Check the last screenshot below against what that page should show.',
  },
  {
    id: 'visual-assertion',
    match: /^visual assertion failed:/i,
    headline: "The page didn't look the way it was supposed to.",
    whoseFault: 'your app',
    nextStep: 'Compare the screenshot below against what that page should show.',
  },
  {
    id: 'crashed',
    match: /^run crashed:/i,
    headline: 'Something went wrong inside the test itself.',
    whoseFault: 'the test',
    nextStep: 'Run it again — if it keeps happening, the details are in the report.',
  },
  {
    id: 'stuck',
    // Loose catch-all for the remaining "stuck: …" wordings; kept LAST of the
    // stuck family so the specific ones above win.
    match: /^stuck:/i,
    headline: 'The test got stuck on the page and stopped.',
    whoseFault: 'your app',
    nextStep: 'Look at the last step below — that is where it stopped making progress.',
  },
];

/** Translate one raw reason. Returns null when nothing matches — the caller
 * then shows the original text rather than inventing an explanation for a
 * reason nobody has taught this table about. */
export function explainReason(reason: string | undefined | null): ReasonExplanation | null {
  const text = String(reason ?? '').trim();
  if (!text) return null;
  const rule = REASON_RULES.find((r) => r.match.test(text));
  if (!rule) return null;
  const { match: _match, ...explanation } = rule;
  return explanation;
}

/** The whole thing as the two lines a report or a card shows: what happened,
 * whose problem it is, and what to do. Falls back to the raw reason when the
 * table doesn't know it, so nothing is ever swallowed. */
export function plainReasonText(reason: string | undefined | null): string {
  const e = explainReason(reason);
  if (!e) return String(reason ?? '').trim();
  return `${e.headline} (${whoseFaultLabel(e.whoseFault)})\n${e.nextStep}`;
}

/** The attribution as it reads on screen. */
export function whoseFaultLabel(whose: WhoseFault): string {
  if (whose === 'your app') return 'this looks like a problem in your app';
  if (whose === 'setup') return "this isn't a problem in your app — it's a setup problem";
  return "this isn't a problem in your app — the test couldn't get there";
}
