/* `spike setup --strict` (E4): an optional Claude Code Stop hook that nudges the
 * agent to run Spike when it changed UI files this turn and is about to finish
 * without having run a browser check. The hook command is `spike hook-stop`;
 * this module is its pure decision logic (transcript text in, decision out). */

export const STOP_HOOK_COMMAND = 'spike hook-stop';

const UI_FILE = /\.(tsx|jsx|vue|svelte|astro|html?|css|scss|sass|less)$/i;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export interface StopHookInput { transcript_path?: string; stop_hook_active?: boolean }
export interface StopHookDecision { block: boolean; reason?: string }

export const NUDGE =
  'You changed files a user can see in a browser but have not run a Spike check this turn. Run it now: call the qa_run tool (or `spike run "<one-sentence task>" --url <dev server url> --json`), fix anything it reports, then finish. If no dev server is running or the check does not apply, say so plainly instead of claiming the change works.';

function blocksOf(entry: any): any[] {
  const c = entry?.message?.content;
  return Array.isArray(c) ? c : [];
}

/** True when this transcript entry is a real user prompt (not a tool result). */
function isUserPrompt(entry: any): boolean {
  if (entry?.type !== 'user') return false;
  const c = entry?.message?.content;
  if (typeof c === 'string') return c.trim() !== '';
  return Array.isArray(c) && c.some((b) => b?.type === 'text' && String(b.text ?? '').trim() !== '') && !c.some((b) => b?.type === 'tool_result');
}

function ranSpike(block: any): boolean {
  if (block?.type !== 'tool_use') return false;
  const name = String(block.name ?? '');
  if (/(^|__)spike__qa_run$/.test(name) || /^mcp__spike__/.test(name)) return true;
  return name === 'Bash' && /\bspike\s+(run|check|replay|suite|ci)\b/.test(String(block.input?.command ?? ''));
}

/** Decides from the transcript (JSONL text) whether to nudge. Looks only at the current turn (since the last user prompt). */
export function evaluateStop(input: StopHookInput, transcriptText: string | null): StopHookDecision {
  if (input.stop_hook_active) return { block: false }; // already nudged once: never loop
  if (!transcriptText) return { block: false };
  const entries: any[] = [];
  for (const line of transcriptText.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* skip a torn line */ }
  }
  let start = 0;
  entries.forEach((e, i) => { if (isUserPrompt(e)) start = i + 1; });
  let editedUi = false, checked = false;
  for (const e of entries.slice(start)) {
    for (const b of blocksOf(e)) {
      if (b?.type === 'tool_use' && EDIT_TOOLS.has(String(b.name)) && UI_FILE.test(String(b.input?.file_path ?? b.input?.notebook_path ?? ''))) editedUi = true;
      if (ranSpike(b)) checked = true;
    }
  }
  return editedUi && !checked ? { block: true, reason: NUDGE } : { block: false };
}

/** What `spike hook-stop` prints: nothing to allow the stop, or the block JSON Claude Code reads. */
export function hookStopOutput(d: StopHookDecision): string {
  return d.block ? JSON.stringify({ decision: 'block', reason: d.reason }) : '';
}
