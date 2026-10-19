// Schedule (config kind `schedule`, `org/schedules/<id>.json`; SPEC 5, 12, S11). A schedule either starts a
// workflow (through its trigger.schedule node) or creates a plain Task.
import { z } from 'zod';
import { doneCondition, SLUG_RE, slug, ts } from './common.ts';
import { CRON_RE, NODE_ID_RE } from './node-types.ts';

export const scheduleSchema = z
  .strictObject({
    id: z.string().regex(SLUG_RE),
    departmentId: slug.optional(),
    goalId: z.string().optional(),
    cron: z.string().regex(CRON_RE, 'cron must have 5 fields'),
    tz: z.string().min(1),
    creates: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('workflow'), workflowId: slug, triggerNodeId: z.string().regex(NODE_ID_RE).optional() }),
      z.strictObject({
        kind: z.literal('task'),
        title: z.string().min(1).max(140),
        taskType: z.string().min(1),
        ownerAgentId: slug,
        acceptance: z.array(z.string().min(1)).min(1),
      }),
    ]),
    catchUp: z.enum(['once', 'skip', 'all']).default('once'),
    overnight: z.boolean().optional(),
    status: z.enum(['active', 'paused']),
    postponeUntil: ts.optional(),
    doneCondition: doneCondition.optional().describe('required if overnight'),
  })
  .superRefine((s, ctx) => {
    if (s.overnight && !s.doneCondition) {
      ctx.addIssue({ code: 'custom', path: ['doneCondition'], message: 'an overnight schedule needs a doneCondition' });
    }
  });
export type Schedule = z.infer<typeof scheduleSchema>;
