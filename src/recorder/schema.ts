/* Recorded-script schema — runtime validation for QaScript (A14).
 *
 * `loadScript()` used to do `JSON.parse(...) as QaScript` — a compile-time-only
 * assertion that vanishes at runtime. A hand-written or hand-edited script (the
 * direct answer to "I don't want an AI hallucinating in my regression suite")
 * got zero real checking: a typo'd field name, a wrong type, or a missing
 * target would sail through `loadScript()` and only blow up later, deep inside
 * `replay.ts`, with a confusing error far from the actual mistake.
 *
 * This file is the runtime twin of the `QaScript`/`ScriptStep`/`ScriptTarget`
 * types in `script.ts` (source of truth for the shapes — read that file
 * first). Same conventions as `driver/script-runner/schema.ts`:
 *   - `z.discriminatedUnion('type', [...])` over the step variants, so a
 *     malformed step is matched to exactly one branch (via its `type`) and
 *     reports errors against that branch only, not every branch at once.
 *   - `.strict()` on every object so an unknown/misspelled key (`"contians"`
 *     instead of `"contains"`) is rejected outright, not silently ignored.
 *
 * The nested `{type:'script', steps:[...]}` sub-DSL already has its own zod
 * schema (`ScriptRunnerStepSchema`) that is genuinely enforced a SECOND time
 * at replay (replay.ts re-validates before executing — a script step is never
 * trusted just because it was recorded/loaded). We import and reuse that
 * schema here rather than re-describing the same allowlist, so the two never
 * drift apart. */

import { z } from 'zod';
import type { QaScript, ScriptStep, ScriptTarget } from './script.js';
import { ScriptRunnerStepSchema } from '../driver/script-runner/schema.js';

/** Locator schema shared by every step that targets a page element. `nth` and
 * `qaId` are the same optional disambiguators documented on `ScriptTarget` in
 * script.ts — both are best-effort fallbacks, never required. */
export const ScriptTargetSchema = z
  .object({
    role: z.string(),
    name: z.string().optional(),
    nth: z.number().int().nonnegative().optional(),
    qaId: z.string().optional(),
  })
  .strict();

/** One branch per `ScriptStep` variant (script.ts:32-68), in the same order,
 * so a diff against that file is easy to eyeball. Every branch is `.strict()`
 * — see the file header for why that matters for hand-authored scripts. */
export const ScriptStepSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('navigate'), url: z.string() }).strict(),
  z.object({ type: z.literal('click'), target: ScriptTargetSchema }).strict(),
  z.object({ type: z.literal('type'), target: ScriptTargetSchema, text: z.string() }).strict(),
  z.object({ type: z.literal('hover'), target: ScriptTargetSchema }).strict(),
  z.object({ type: z.literal('press_key'), key: z.string() }).strict(),
  z.object({ type: z.literal('select_option'), target: ScriptTargetSchema, value: z.string() }).strict(),
  z.object({ type: z.literal('reload') }).strict(),
  z.object({ type: z.literal('go_back') }).strict(),
  z.object({ type: z.literal('assert_dom'), target: ScriptTargetSchema, contains: z.string() }).strict(),
  // Phase 15 model-assisted extract: `target` is optional (whole-page prompt
  // mode) and `prompt` is the model-assisted key; both `pattern` and `prompt`
  // are optional so a plain DOM-text extract (no prompt/pattern) is also valid.
  z
    .object({
      type: z.literal('extract'),
      target: ScriptTargetSchema.optional(),
      key: z.string(),
      pattern: z.string().optional(),
      prompt: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('assert_visual'),
      expectation: z.string(),
      mode: z.enum(['screenshot', 'video']).optional(),
    })
    .strict(),
  z.object({ type: z.literal('wait'), ms: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('upload_file'), target: ScriptTargetSchema, paths: z.array(z.string()) }).strict(),
  // drag_and_drop's drop-zone `target` is best-effort (loop.ts) — only present
  // when the driver resolved a role+name for it, so it must stay optional.
  z
    .object({
      type: z.literal('drag_and_drop'),
      source: ScriptTargetSchema,
      target: ScriptTargetSchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal('blur'), target: ScriptTargetSchema }).strict(),
  z
    .object({
      type: z.literal('mouse'),
      kind: z.enum(['move', 'down', 'up']),
      x: z.number(),
      y: z.number(),
    })
    .strict(),
  z.object({ type: z.literal('open_tab'), url: z.string() }).strict(),
  // tabIndex is a REPLAYABLE index (0 = the tab active when the script
  // started; N>=1 = the Nth open_tab call in this script), never a raw
  // runtime id — see tabIndexFor() in script.ts.
  z.object({ type: z.literal('switch_tab'), tabIndex: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('close_tab'), tabIndex: z.number().int().nonnegative() }).strict(),
  // Reused, not re-described: the secure script runner's own schema is the
  // single source of truth for what's allowlisted inside a `script` step, and
  // replay.ts re-validates against it independently before execution anyway.
  z.object({ type: z.literal('script'), steps: z.array(ScriptRunnerStepSchema) }).strict(),
]);

/** Top-level recorded-script shape (script.ts:70-80). `version` is pinned to
 * the literal `1` — there is only one script format today, and a future v2
 * would need its own schema branch here rather than a silent field addition. */
export const QaScriptSchema = z
  .object({
    version: z.literal(1),
    name: z.string(),
    task: z.string(),
    url: z.string(),
    sourceRunId: z.string(),
    createdAt: z.string(),
    healedFrom: z
      .object({
        runId: z.string(),
        failedStep: z.number().int().nonnegative(),
        healedAt: z.string(),
      })
      .strict()
      .optional(),
    steps: z.array(ScriptStepSchema),
  })
  .strict();

/* ---------- compile-time drift guard ----------
 *
 * The zod schema above is hand-maintained alongside the TS interfaces in
 * script.ts, not derived from them (or vice versa) — so nothing stops the two
 * from silently drifting apart when one is edited and the other isn't. These
 * two assignments turn that drift into a `tsc --noEmit` failure instead of a
 * runtime surprise:
 *   - forward: every value the schema can produce must satisfy `QaScript` —
 *     catches a field the interface requires that the schema forgot (or typed
 *     wider/narrower than the interface allows).
 *   - reverse: every value that satisfies `QaScript` must be assignable to
 *     what the schema infers — catches a field the interface has that the
 *     schema doesn't know about at all.
 * Both are trivial `{}` casts assigned to a differently-typed local — they do
 * no real work at runtime (an object literal assigned to an unused const),
 * but the assignment only TYPE-CHECKS when the two shapes line up. */
type InferredQaScript = z.infer<typeof QaScriptSchema>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _forwardDriftCheck: QaScript = {} as InferredQaScript;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _reverseDriftCheck: InferredQaScript = {} as QaScript;

// Re-exported so callers can reference the exact locator/step shapes without
// reaching back into script.ts for the zod-adjacent types.
export type { ScriptTarget, ScriptStep, QaScript };

/** Format one zod issue as `path.to.field: message` (e.g.
 * `steps[3].target.role: Required`), matching how a hand-editor thinks about
 * "where in my JSON is the mistake" — array indices in brackets, object keys
 * dot-separated, root-level issues (e.g. an unknown top-level key) as
 * `(root): <message>`. */
function formatIssue(issue: z.ZodIssue): string {
  if (issue.path.length === 0) return `(root): ${issue.message}`;
  const path = issue.path.reduce<string>((acc, seg, i) => {
    if (typeof seg === 'number') return `${acc}[${seg}]`;
    return i === 0 ? String(seg) : `${acc}.${seg}`;
  }, '');
  return `${path}: ${issue.message}`;
}

/** Validate an arbitrary parsed-JSON value as a `QaScript`. Returns the parsed
 * (and now type-safe) script on success, or a list of readable, path-prefixed
 * error strings on failure — callers (loadScript, and any future `spike
 * validate` command) decide how to surface those. */
export function validateQaScript(raw: unknown): { ok: true; script: QaScript } | { ok: false; errors: string[] } {
  const result = QaScriptSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, script: result.data };
  }
  return { ok: false, errors: result.error.issues.map(formatIssue) };
}
