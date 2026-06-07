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

export const PlanResultSchema = z.object({
  thought: z.string(),
  action: ActionSchema,
});

export type PlanResult = z.infer<typeof PlanResultSchema>;

/** JSON-schema twin of PlanResultSchema, given to planner models as a response constraint. */
export const PLAN_JSON_SCHEMA = {
  type: 'object',
  required: ['thought', 'action'],
  additionalProperties: false,
  properties: {
    thought: { type: 'string', description: 'one short sentence of reasoning' },
    action: {
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
} as const;
