// Approval: a single-use, expiring decision bound to an action hash (PHASE-1-PLAN 3.1).
import { z } from 'zod';
import { id, postingMode, sha256, tosRisk, ts } from './common.ts';

export const approvalSchema = z
  .strictObject({
    id,
    kind: z.enum(['publish', 'spend', 'deploy', 'external', 'org_change', 'grant', 'autonomy']),
    actionHash: sha256,
    taskId: id.optional(),
    verdictId: id.optional(),
    summary: z.string().min(1).max(400),
    payloadRef: z.string().optional().describe('path to staged item; never secrets'),
    channel: z
      .strictObject({
        id: z.string().optional(),
        mode: postingMode.optional(),
        method: z.enum(['copy', 'official_api', 'browser']).optional(),
        tosRisk: tosRisk.optional(),
      })
      .optional(),
    requestedBy: z.string().min(1),
    approverRequired: z.string().min(1).describe("'owner' | 'finance' | agentId"),
    status: z.enum(['pending', 'approved', 'reserved', 'consumed', 'released', 'denied', 'expired']),
    usesLeft: z.int().min(0).max(1),
    decidedBy: z.string().optional(),
    decidedAt: ts.optional(),
    reason: z.string().optional(),
    postponedUntil: ts.optional(),
    createdAt: ts,
    expiresAt: ts,
  })
  .superRefine((a, ctx) => {
    if (a.status === 'consumed' && a.usesLeft !== 0) {
      ctx.addIssue({ code: 'custom', path: ['usesLeft'], message: 'a consumed approval has usesLeft 0' });
    }
    if (a.decidedBy && a.decidedBy === a.requestedBy) {
      ctx.addIssue({ code: 'custom', path: ['decidedBy'], message: 'an approval cannot be decided by its requester' });
    }
  });
export type Approval = z.infer<typeof approvalSchema>;
