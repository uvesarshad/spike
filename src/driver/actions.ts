/* The driver's action vocabulary — one JSON action per planner step.
 * The JSON schema is handed to planner models as a response constraint;
 * the zod schema validates whatever comes back. */

import { z } from 'zod';

export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('navigate'), url: z.string() }),
  z.object({ type: z.literal('click'), nodeId: z.string() }),
  z.object({ type: z.literal('type'), nodeId: z.string(), text: z.string() }),
  z.object({ type: z.literal('assert_visual'), expectation: z.string() }),
  z.object({ type: z.literal('assert_dom'), nodeId: z.string(), contains: z.string() }),
  z.object({ type: z.literal('wait'), ms: z.number().int().min(50).max(10_000) }),
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
            enum: ['navigate', 'click', 'type', 'assert_visual', 'assert_dom', 'wait', 'finish'],
          },
          url: { type: 'string' },
          nodeId: { type: 'string' },
          text: { type: 'string' },
          expectation: { type: 'string' },
          contains: { type: 'string' },
          ms: { type: 'integer' },
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

/** BRAIN output: the sub-goal checklist (initial plan or a re-plan on escalation).
 * On escalation the brain may return revised remaining `goals`, a `hint` for the
 * navigator, or a final `verdict` (with `reason`) when the task is done/impossible. */
export const GoalPlanSchema = z.object({
  thought: z.string(),
  goals: z.array(z.string()).min(1).optional(),
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
      description: 'ordered sub-goals for the navigator to execute one at a time',
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
