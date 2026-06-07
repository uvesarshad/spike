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
