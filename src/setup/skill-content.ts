/* Single source for the text `spike setup` puts in front of coding agents (A2).
 * This is read by agents, so it may name commands and flags. */

export const BLOCK_BEGIN = '<!-- spike:begin -->';
export const BLOCK_END = '<!-- spike:end -->';

const DESCRIPTION =
  'Check in a real browser that a web change works before you say it is done: after any UI-visible change, when a page, form, login or checkout might be broken, or when the user reports something looks wrong. Runs a cheap-model browser test and returns a short pass/fail verdict.';

/** The shared instruction body (no frontmatter). Kept under ~400 words. */
export function skillBody(): string {
  return `# Spike: browser check for web changes

## When to use it
- After any change a user can see in a browser, before telling the user it is done.
- When the user says something looks broken or a flow does not work.
- Prefer the dev server URL (for example http://localhost:3000).

## How to call it
- If the \`spike\` MCP server is registered, call the \`qa_run\` tool with a \`url\` and a one-sentence \`task\`.
- Otherwise run: \`spike run "<one-sentence task>" --url <url> --json\`
- For a whole document of requirements: \`spike run --spec <file.md> --url <url>\`
- To scan a whole site: \`spike check <url>\`

## Reading the verdict
- \`pass\`: the flow worked. Say so and move on.
- \`fail\`: read \`failing_step\` and \`fix_hint\`, fix the code, then run it again. Do not stop after one failure.
- \`uncertain\`: the check could not decide. Never claim success. Look at the evidence paths or ask the user.

## Rules
- Never put passwords or tokens in the task text. Store them once with \`spike secret set NAME\` and refer to them as \`{{secret:NAME}}\`, for example "log in with {{secret:TEST_USER}} and {{secret:TEST_PASSWORD}}".
- For pages behind a login, reuse a saved session with \`--storage-state <file>\` instead of logging in again.
- Only test sites the user owns or is allowed to test. Keep tasks to non-destructive checks unless the user says otherwise.
`;
}

/** (a) SKILL.md with frontmatter (Claude Code skills). */
export function renderSkillMd(): string {
  return `---\nname: spike\ndescription: ${DESCRIPTION}\n---\n\n${skillBody()}`;
}

/** (b) The fenced AGENTS.md / instructions block. */
export function renderAgentsBlock(): string {
  return `${BLOCK_BEGIN}\n${skillBody().trimEnd()}\n${BLOCK_END}\n`;
}

/** (c) Cursor rule, description-triggered. */
export function renderCursorRule(): string {
  return `---\ndescription: ${DESCRIPTION}\nalwaysApply: false\n---\n\n${skillBody()}`;
}
