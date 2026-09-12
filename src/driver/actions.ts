/* The driver's action vocabulary — one JSON action per planner step.
 * The JSON schema is handed to planner models as a response constraint;
 * the zod schema validates whatever comes back. */

import { z } from 'zod';
import { ScriptRunnerStepSchema, SCRIPT_MAX_STEPS, SCRIPT_STEP_JSON_SCHEMA } from './script-runner/schema.js';

export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('navigate'), url: z.string() }),
  z.object({ type: z.literal('click'), nodeId: z.string() }),
  z.object({ type: z.literal('type'), nodeId: z.string(), text: z.string() }),
  z.object({ type: z.literal('hover'), nodeId: z.string() }),
  z.object({ type: z.literal('press_key'), key: z.string() }),
  z.object({ type: z.literal('select_option'), nodeId: z.string(), value: z.string() }),
  z.object({ type: z.literal('reload') }),
  z.object({ type: z.literal('go_back') }),
  // Phase 9 — action parity: file upload, drag/drop, discrete mouse, blur, tabs.
  z.object({ type: z.literal('upload_file'), nodeId: z.string(), paths: z.array(z.string()).min(1).max(10) }),
  z.object({
    type: z.literal('drag_and_drop'),
    sourceId: z.string(),
    targetId: z.string(),
    // Resolved by the driver loop AFTER execution from the live a11y tree —
    // NEVER emitted by the model (absent from PLAN_JSON_SCHEMA below). This is
    // what lets the recorder distill a role+name-locator replay step without a
    // second StepRecord.target slot (StepRecord only carries one).
    sourceTarget: z.object({ role: z.string(), name: z.string().optional(), nth: z.number().int().optional() }).optional(),
    targetTarget: z.object({ role: z.string(), name: z.string().optional(), nth: z.number().int().optional() }).optional(),
  }),
  z.object({ type: z.literal('blur'), nodeId: z.string() }),
  z.object({ type: z.literal('mouse'), kind: z.enum(['move', 'down', 'up']), x: z.number(), y: z.number() }),
  z.object({ type: z.literal('open_tab'), url: z.string() }),
  z.object({ type: z.literal('switch_tab'), tabId: z.string() }),
  z.object({ type: z.literal('close_tab'), tabId: z.string() }),
  z.object({ type: z.literal('assert_visual'), expectation: z.string(), mode: z.enum(['screenshot', 'video']).optional() }),
  z.object({ type: z.literal('assert_dom'), nodeId: z.string(), contains: z.string() }),
  // A5 — precise assertion vocabulary (src/assertions/dom-assertions.ts is the
  // pure evaluator; loop.ts wires these in). Additive: assert_dom above is
  // UNCHANGED (recorded scripts and the action cache still reference it as
  // the case-insensitive-substring verb) — these are new, more precise verbs
  // alongside it, not a replacement.
  z.object({
    type: z.literal('assert_text'),
    target: z.string().optional(), // nodeId; omitted = whole page text
    mode: z.enum(['exact', 'contains', 'regex']),
    value: z.string(),
  }),
  z.object({
    type: z.literal('assert_count'),
    role: z.string(),
    name: z.string().optional(), // omitted = match role only
    expected: z.number().int().min(0),
    comparator: z.enum(['eq', 'gte', 'lte']),
  }),
  z.object({
    type: z.literal('assert_url'),
    mode: z.enum(['exact', 'contains', 'regex']),
    value: z.string(),
  }),
  z.object({
    type: z.literal('assert_state'),
    target: z.string(), // nodeId
    state: z.enum(['visible', 'hidden', 'enabled', 'disabled', 'checked', 'focused']),
  }),
  z.object({
    type: z.literal('assert_network'),
    urlPattern: z.string(), // regex, compiled defensively
    status: z.number().int().optional(),
    statusClass: z.enum(['2xx', '3xx', '4xx', '5xx']).optional(),
    absent: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('assert_no_console_errors'),
    allow: z.array(z.string()).optional(), // substrings that are OK to ignore
  }),
  // Phase 15 — extract gains an optional model-assisted mode: when `prompt` is
  // present, a cheap text adapter pulls a structured value out of the page/
  // subtree text instead of the $0 DOM-text/regex path. `nodeId` becomes
  // optional so a prompt can target the whole page (e.g. "the order number
  // shown anywhere on this page") rather than one specific node's subtree.
  z.object({
    type: z.literal('extract'),
    nodeId: z.string().optional(),
    key: z.string(),
    pattern: z.string().optional(),
    prompt: z.string().optional(),
  }),
  z.object({ type: z.literal('wait'), ms: z.number().int().min(50).max(10_000) }),
  // Email/OTP module wiring: polls the configured EmailProvider (src/email/)
  // until a message matching `matching` (subject/body substring, case-
  // insensitive; omit to take the newest message) arrives, bounded by
  // `timeoutMs` (default 30s — see loop.ts's WAIT_FOR_EMAIL_DEFAULT_TIMEOUT_MS).
  // When `extractOtpTo` is set, findOtp() runs over the matched message and the
  // result is stored via the SAME recordExtraction() mechanism `extract` uses
  // (source: 'email'). Never cached (see action-cache.ts) — the match depends
  // on external, non-replayable state.
  z.object({
    type: z.literal('wait_for_email'),
    matching: z.string().optional(),
    extractOtpTo: z.string().optional(),
    timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  }),
  // Phase 10 — secure script runner: a small allowlisted declarative step list
  // over BrowserPort verbs (see src/driver/script-runner/). Validated BEFORE
  // execution; a validation failure rejects the whole action (loop.ts treats
  // that as a stuck/escalate condition, never a partial execution).
  z.object({ type: z.literal('script'), steps: z.array(ScriptRunnerStepSchema).min(1).max(SCRIPT_MAX_STEPS) }),
  z.object({
    type: z.literal('finish'),
    verdict: z.enum(['pass', 'fail']),
    reason: z.string(),
  }),
]);

export type Action = z.infer<typeof ActionSchema>;

/** NAVIGATOR result: either 1-3 actions to run, or goalComplete (current goal is
 * already satisfied — the planner advances), or blocked (a reason the navigator
 * cannot proceed — the planner is re-consulted). Exactly one of the three. */
export const PlanResultSchema = z
  .object({
    thought: z.string(),
    /** 1-3 actions; the loop may discard the tail of the batch (see loop.ts). */
    actions: z.array(ActionSchema).min(1).max(3).optional(),
    goalComplete: z.boolean().optional(),
    blocked: z.string().optional(),
  })
  .refine((r) => !!(r.actions?.length || r.goalComplete || r.blocked), {
    message: 'navigator must return actions, goalComplete, or blocked',
  });

export type PlanResult = z.infer<typeof PlanResultSchema>;

/** JSON-schema twin of PlanResultSchema, given to the navigator as a response
 * constraint. `actions` is no longer required: the navigator may instead signal
 * goalComplete (current goal met) or blocked (cannot proceed). */
export const PLAN_JSON_SCHEMA = {
  type: 'object',
  required: ['thought'],
  additionalProperties: false,
  properties: {
    thought: { type: 'string', description: 'one short sentence of reasoning' },
    actions: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      description:
        '1-3 actions to run in sequence; only batch ones independent of each other. Omit when signalling goalComplete or blocked.',
      items: {
        type: 'object',
        required: ['type'],
        properties: {
          type: {
            type: 'string',
            enum: [
              'navigate',
              'click',
              'type',
              'hover',
              'press_key',
              'select_option',
              'reload',
              'go_back',
              'upload_file',
              'drag_and_drop',
              'blur',
              'mouse',
              'open_tab',
              'switch_tab',
              'close_tab',
              'assert_visual',
              'assert_dom',
              'assert_text',
              'assert_count',
              'assert_url',
              'assert_state',
              'assert_network',
              'assert_no_console_errors',
              'extract',
              'wait',
              'wait_for_email',
              'script',
              'finish',
            ],
          },
          url: { type: 'string' },
          nodeId: { type: 'string' },
          text: { type: 'string' },
          key: { type: 'string' },
          value: { type: 'string', description: 'select_option value, OR assert_text/assert_url expected value' },
          expectation: { type: 'string' },
          mode: { type: 'string', enum: ['screenshot', 'video', 'exact', 'contains', 'regex'], description: 'assert_visual: screenshot|video. assert_text/assert_url: exact|contains|regex' },
          contains: { type: 'string' },
          pattern: { type: 'string' },
          target: { type: 'string', description: 'assert_text/assert_state: nodeId (assert_text: omit for whole-page text)' },
          role: { type: 'string', description: 'assert_count: AX role to count' },
          name: { type: 'string', description: 'assert_count: accessible name filter (omit to match role only)' },
          expected: { type: 'integer', description: 'assert_count: expected count' },
          comparator: { type: 'string', enum: ['eq', 'gte', 'lte'], description: 'assert_count: how expected compares to the actual count' },
          state: { type: 'string', enum: ['visible', 'hidden', 'enabled', 'disabled', 'checked', 'focused'], description: 'assert_state: expected state of target' },
          urlPattern: { type: 'string', description: 'assert_network: regex over request URLs' },
          status: { type: 'integer', description: 'assert_network: exact HTTP status to require' },
          statusClass: { type: 'string', enum: ['2xx', '3xx', '4xx', '5xx'], description: 'assert_network: status class to require' },
          absent: { type: 'boolean', description: 'assert_network: true = assert NO matching request occurred' },
          allow: { type: 'array', items: { type: 'string' }, description: 'assert_no_console_errors: substrings of errors to ignore' },
          prompt: { type: 'string', description: 'when set on extract, ask a cheap text model to pull the value instead of DOM-text/regex' },
          ms: { type: 'integer' },
          matching: { type: 'string', description: 'wait_for_email: only match an email whose subject or body contains this substring (case-insensitive); omit to take the newest email' },
          extractOtpTo: { type: 'string', description: 'wait_for_email: run-data key to store an OTP/code extracted from the matched email as {{run.<key>}}' },
          timeoutMs: { type: 'integer', description: 'wait_for_email: max time (ms) to wait for a matching email; default 30000' },
          paths: { type: 'array', items: { type: 'string' }, description: 'upload_file: file paths to set on the input' },
          sourceId: { type: 'string', description: 'drag_and_drop: nodeId to press on' },
          targetId: { type: 'string', description: 'drag_and_drop: nodeId to release on' },
          kind: { type: 'string', enum: ['move', 'down', 'up'], description: 'mouse: which discrete event to dispatch' },
          x: { type: 'number', description: 'mouse: page x coordinate' },
          y: { type: 'number', description: 'mouse: page y coordinate' },
          tabId: { type: 'string', description: 'switch_tab/close_tab: id returned by a prior open_tab' },
          steps: {
            type: 'array',
            minItems: 1,
            maxItems: SCRIPT_MAX_STEPS,
            description: 'script: a small allowlisted step list over the SAME verbs (no assert_visual/finish/script — see docs/modules/script-runner.md)',
            items: SCRIPT_STEP_JSON_SCHEMA,
          },
          verdict: { type: 'string', enum: ['pass', 'fail'] },
          reason: { type: 'string' },
        },
      },
    },
    goalComplete: {
      type: 'boolean',
      description: 'true when the CURRENT GOAL is already satisfied by the page (instead of actions)',
    },
    blocked: {
      type: 'string',
      description: 'reason the page stops progress and you cannot proceed (instead of actions)',
    },
  },
} as const;

/** A9 (P0): the response schema for THIS run.
 *
 * `wait_for_email` is only real when an inbox is wired up, so with none
 * configured the verb is dropped from the action-type enum — a schema-enforced
 * model then cannot emit it at all, rather than being told about a verb that
 * always fails. Mirrors planner-prompt.ts's actionRulesAndVocabulary(), which
 * removes the same verb from the prose: the prompt and the schema must never
 * disagree about what exists.
 *
 * Returns the shared constant untouched in the enabled case — no clone, no
 * drift. In the disabled case the copy is shallow apart from the one enum it
 * rewrites, and the email-only property descriptions are left in place: they
 * describe fields no remaining verb uses, which costs a few tokens and cannot
 * reintroduce the verb. */
export function planJsonSchema(opts: { emailEnabled: boolean }): typeof PLAN_JSON_SCHEMA {
  if (opts.emailEnabled) return PLAN_JSON_SCHEMA;
  const items = PLAN_JSON_SCHEMA.properties.actions.items;
  return {
    ...PLAN_JSON_SCHEMA,
    properties: {
      ...PLAN_JSON_SCHEMA.properties,
      actions: {
        ...PLAN_JSON_SCHEMA.properties.actions,
        items: {
          ...items,
          properties: {
            ...items.properties,
            type: {
              ...items.properties.type,
              enum: items.properties.type.enum.filter((t) => t !== 'wait_for_email'),
            },
          },
        },
      },
    },
  } as unknown as typeof PLAN_JSON_SCHEMA;
}

/** BRAIN output: the sub-goal checklist (initial plan or a re-plan on escalation).
 * On escalation the brain may return revised remaining `goals`, a `hint` for the
 * navigator, or a final `verdict` (with `reason`) when the task is done/impossible. */
export const GoalPlanSchema = z.object({
  thought: z.string(),
  // A26 (P1): capped at 12 — an oversized goal list paired with an
  // instant-goalComplete navigator is unbounded LLM calls that never trip
  // maxSteps (see loop.ts's maxGoalTransitions guard, which bounds the OTHER
  // half of this: how many goal transitions a run may consume even across
  // brain re-plans).
  goals: z.array(z.string()).min(1).max(12).optional(),
  hint: z.string().optional(),
  verdict: z.enum(['pass', 'fail']).optional(),
  reason: z.string().optional(),
});

export type GoalPlan = z.infer<typeof GoalPlanSchema>;

/** JSON-schema twin of GoalPlanSchema, given to the brain as a response constraint. */
export const GOAL_PLAN_JSON_SCHEMA = {
  type: 'object',
  required: ['thought'],
  additionalProperties: false,
  properties: {
    thought: { type: 'string', description: 'one short sentence of reasoning' },
    goals: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      description: 'ordered sub-goals for the navigator to execute one at a time (max 12)',
      items: { type: 'string' },
    },
    hint: { type: 'string', description: 'a hint for the navigator instead of re-planning the goals' },
    verdict: {
      type: 'string',
      enum: ['pass', 'fail'],
      description: 'final verdict when the task is already complete or is impossible',
    },
    reason: { type: 'string', description: 'why the verdict was reached' },
  },
} as const;

/* ------------------------------------------------------------------------- *
 * Phase 15 — model-assisted structured extraction. When an `extract` action
 * carries a `prompt`, loop.ts asks a cheap plan-step-capable TEXT adapter
 * (router.planJson — the SAME call the navigator uses, no new router surface)
 * to pull a structured value out of the serialized page/subtree text. This is
 * NOT a visual call — no image, no vision adapter, no extra router method.
 * ------------------------------------------------------------------------- */

export const ExtractResultSchema = z.object({
  value: z.string().nullable().optional(),
});

export type ExtractResult = z.infer<typeof ExtractResultSchema>;

export const EXTRACT_JSON_SCHEMA = {
  type: 'object',
  required: [],
  additionalProperties: false,
  properties: {
    value: {
      type: ['string', 'null'],
      description: 'the extracted value as plain text, or null if it is not present in the given text',
    },
  },
} as const;

export function buildExtractPrompt(input: { prompt: string; key: string; text: string }): string {
  return `Extract a single value from the page text below.

WHAT TO EXTRACT: ${input.prompt}
(this will be stored as {{run.${input.key}}} for later steps)

PAGE TEXT:
${input.text.slice(0, 4000)}

Respond with ONLY JSON: {"value": "<the extracted text>"} or {"value": null} if it is not present. Do not invent a value that is not visibly present in the text above.`;
}
