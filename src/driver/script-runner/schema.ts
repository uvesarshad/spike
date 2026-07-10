/* Secure script runner — schema. A `script` action's body is a SMALL
 * allowlisted declarative step list over BrowserPort verbs — NOT raw
 * Playwright/Node, NO eval. Every step type here maps 1:1 to an existing
 * BrowserPort method (or a DOM-text-only extract/assert, same as the main
 * driver loop). Tab primitives and meta-actions (assert_visual, finish,
 * script itself) are deliberately excluded — the runner never recurses and
 * never drives a visual/model call.
 *
 * `.strict()` on every step object rejects unknown keys outright (a model or
 * a hand-written script cannot smuggle an extra field past the allowlist). */

import { z } from 'zod';

/** Hard cap on steps per script action — bounds both validation and
 * execution cost; a script this small is a targeted escape hatch, not a
 * general automation language. */
export const SCRIPT_MAX_STEPS = 20;
/** Hard wall-time cap for executing one script action, in ms. */
export const SCRIPT_MAX_WALL_MS = 30_000;

export const ScriptRunnerStepSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('navigate'), url: z.string() }).strict(),
  z.object({ type: z.literal('click'), nodeId: z.string() }).strict(),
  z.object({ type: z.literal('type'), nodeId: z.string(), text: z.string() }).strict(),
  z.object({ type: z.literal('hover'), nodeId: z.string() }).strict(),
  z.object({ type: z.literal('press_key'), key: z.string() }).strict(),
  z.object({ type: z.literal('select_option'), nodeId: z.string(), value: z.string() }).strict(),
  z.object({ type: z.literal('reload') }).strict(),
  z.object({ type: z.literal('go_back') }).strict(),
  z.object({ type: z.literal('wait'), ms: z.number().int().min(50).max(10_000) }).strict(),
  z.object({ type: z.literal('assert_dom'), nodeId: z.string(), contains: z.string() }).strict(),
  z.object({ type: z.literal('extract'), nodeId: z.string(), key: z.string(), pattern: z.string().optional() }).strict(),
  z.object({ type: z.literal('upload_file'), nodeId: z.string(), paths: z.array(z.string()).min(1).max(10) }).strict(),
  z.object({ type: z.literal('drag_and_drop'), sourceId: z.string(), targetId: z.string() }).strict(),
  z.object({ type: z.literal('blur'), nodeId: z.string() }).strict(),
  z.object({ type: z.literal('mouse'), kind: z.enum(['move', 'down', 'up']), x: z.number(), y: z.number() }).strict(),
]);

export type ScriptRunnerStep = z.infer<typeof ScriptRunnerStepSchema>;

/** The allowlisted verb names — used by the validator's error messages and by
 * anything documenting the runner's surface. */
export const SCRIPT_RUNNER_VERBS = [
  'navigate',
  'click',
  'type',
  'hover',
  'press_key',
  'select_option',
  'reload',
  'go_back',
  'wait',
  'assert_dom',
  'extract',
  'upload_file',
  'drag_and_drop',
  'blur',
  'mouse',
] as const;

/** JSON-schema twin of ScriptRunnerStepSchema, given to the navigator as part
 * of the `script` action's `steps` array constraint. Kept flat (one object
 * shape, optional fields) to match the existing PLAN_JSON_SCHEMA convention
 * in src/driver/actions.ts rather than a real discriminated union — model
 * function-calling schemas are more reliable flat. */
export const SCRIPT_STEP_JSON_SCHEMA = {
  type: 'object',
  required: ['type'],
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: [...SCRIPT_RUNNER_VERBS] },
    url: { type: 'string' },
    nodeId: { type: 'string' },
    text: { type: 'string' },
    key: { type: 'string' },
    value: { type: 'string' },
    contains: { type: 'string' },
    pattern: { type: 'string' },
    ms: { type: 'integer' },
    paths: { type: 'array', items: { type: 'string' } },
    sourceId: { type: 'string' },
    targetId: { type: 'string' },
    kind: { type: 'string', enum: ['move', 'down', 'up'] },
    x: { type: 'number' },
    y: { type: 'number' },
  },
} as const;
