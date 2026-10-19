// Routing (config kind `routing`, `org/routing.json`; SPEC 4.7). Task type → tier, keyword routes and
// escalation steps are data from template `defaults-v1`.
import { z } from 'zod';
import { tier } from './common.ts';

const taskType = z.string().regex(/^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*$/);

export const routingSchema = z
  .strictObject({
    defaultTier: tier,
    taskTypes: z.array(
      z.strictObject({
        taskType,
        tier,
        minTier: tier.optional().describe('floor after escalation, e.g. deep for irreversible planning'),
        judgeFamily: z.enum(['other_than_implementer', 'any']).optional(),
        notes: z.string().max(200).optional(),
      }),
    ),
    keywords: z
      .array(z.strictObject({ id: z.string().min(1), match: z.array(z.string().min(1)).min(1), taskType }))
      .optional(),
    classifier: z.strictObject({ taskType, tier }).optional().describe('fallback classifier when no keyword matches'),
    escalation: z.strictObject({
      riskHigh: z.int().min(0).max(2),
      filesOver: z.int().min(1),
      filesStep: z.int().min(0).max(2),
      failedAttempt: z.int().min(0).max(2),
    }),
    flagFloors: z.partialRecord(z.enum(['external', 'irreversible']), tier).optional(),
  })
  .superRefine((r, ctx) => {
    const seen = new Set<string>();
    r.taskTypes.forEach((t, i) => {
      if (seen.has(t.taskType)) ctx.addIssue({ code: 'custom', path: ['taskTypes', i, 'taskType'], message: `duplicate task type '${t.taskType}'` });
      seen.add(t.taskType);
    });
  });
export type Routing = z.infer<typeof routingSchema>;
