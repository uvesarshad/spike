/* The ONE updating pull-request comment (A9). The body builder is pure so it is
 * testable; `upsertCommentPlan` decides create-vs-update from the existing
 * comments, and the GitHub Action performs it with `gh api`. */

import { CI_COMMENT_MARKER } from './ci.js';

export const MAX_COMMENT_CHARS = 60_000;

/** The comment: hidden marker first (how the next run finds it again), the
 * summary, then a link to the run's evidence. */
export function buildPrComment(summaryMarkdown: string, o: { runUrl?: string } = {}): string {
  const footer = o.runUrl ? `\n[Screenshots and full reports for this run](${o.runUrl}) (download the "spike-artifacts" file).\n` : '';
  const body = `${CI_COMMENT_MARKER}\n${summaryMarkdown.trim()}\n${footer}`;
  return body.length > MAX_COMMENT_CHARS ? `${body.slice(0, MAX_COMMENT_CHARS - 40)}\n\n…(cut to fit a comment)\n` : body;
}

export type CommentPlan = { action: 'create' } | { action: 'update'; id: number };

/** Update the marked comment if one exists, otherwise create it. */
export function upsertCommentPlan(existing: { id: number; body?: string | null }[]): CommentPlan {
  const hit = existing.find((c) => c.body?.includes(CI_COMMENT_MARKER));
  return hit ? { action: 'update', id: hit.id } : { action: 'create' };
}
