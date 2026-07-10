/* Shared visual-verdict contract for rungs 1+ (Nano's runner has its own
 * built-in copy of the same schema — keep them in sync). */

export const VERDICT_JSON_SCHEMA = {
  type: 'object',
  required: ['verdict', 'summary', 'issues'],
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail', 'uncertain'] },
    summary: { type: 'string' },
    issues: { type: 'array', items: { type: 'string' } },
  },
} as const;

export function verdictPrompt(expectation: string): string {
  return (
    'You are a QA assistant inspecting a screenshot of a web page.\n' +
    `Question: ${expectation}\n` +
    'Judge strictly from what is visible. List concrete issues if any.\n' +
    'Respond with ONLY a JSON object: {"verdict":"pass"|"fail"|"uncertain","summary":string,"issues":string[]}'
  );
}

/** Prompt for a video-capable verdict (Phase 8, opt-in via cfg.videoAssertions).
 * Same VERDICT_JSON_SCHEMA/shape as the screenshot path — only the framing text
 * differs, since the evidence is a short clip (toast/animation/transient UI)
 * rather than a single frame. */
export function videoVerdictPrompt(expectation: string): string {
  return (
    'You are a QA assistant reviewing a short screen-recording clip of a web page interaction.\n' +
    `Question: ${expectation}\n` +
    'Judge strictly from what is visible across the clip (including transient UI such as toasts, ' +
    'loading states, or animations that a single screenshot could miss). List concrete issues if any.\n' +
    'Respond with ONLY a JSON object: {"verdict":"pass"|"fail"|"uncertain","summary":string,"issues":string[]}'
  );
}
