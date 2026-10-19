// Team: a unit inside a Department (PHASE-1-PLAN 3.2, SPEC 28.1). "autonomy ≤ department" is enforced by
// the config service (P1-C), not here.
import { z } from 'zod';
import { autonomy, dataClass, SLUG_RE, slug } from './common.ts';

export const teamSchema = z
  .strictObject({
    id: z.string().regex(SLUG_RE),
    departmentId: slug,
    name: z.string().min(1).max(60),
    purpose: z.string().max(300).optional(),
    managerAgentId: slug,
    memberAgentIds: z.array(slug),
    connectionIds: z.array(slug).optional(),
    workflowIds: z.array(slug).optional(),
    goalIds: z.array(z.string().min(1)).optional(),
    envelopeId: z.string().optional(),
    autonomy: autonomy.optional().describe('capped at the department level by the config service'),
    dataClass: dataClass.optional(),
    status: z.enum(['active', 'paused', 'dormant', 'retired']),
    fromTemplate: z.string().optional(),
  })
  .superRefine((t, ctx) => {
    if (t.memberAgentIds.includes(t.managerAgentId)) {
      ctx.addIssue({ code: 'custom', path: ['memberAgentIds'], message: 'the manager is not listed as a member' });
    }
    if (new Set(t.memberAgentIds).size !== t.memberAgentIds.length) {
      ctx.addIssue({ code: 'custom', path: ['memberAgentIds'], message: 'duplicate member agent id' });
    }
  });
export type Team = z.infer<typeof teamSchema>;
