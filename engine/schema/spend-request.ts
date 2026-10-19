// SpendRequest (PHASE-1-PLAN 3.1). Schema fixed now for stability; the flow ships in Phase 3 (paper mode).
import { z } from 'zod';
import { evidenceRef, id, ts } from './common.ts';

export const spendRequestSchema = z.strictObject({
  id,
  requesterAgentId: z.string().min(1),
  taskId: id.optional(),
  goalId: z.string().min(1),
  envelopeId: z.string().min(1),
  amount: z.number().gt(0),
  currency: z.literal('USD'),
  recurring: z.strictObject({ every: z.enum(['month', 'year']).optional(), until: ts.optional() }).optional(),
  vendor: z.string().min(1),
  item: z.string().min(1),
  why: z.string().max(600),
  expectedRoi: z.strictObject({ metric: z.string(), value: z.number(), horizonDays: z.int() }),
  alternatives: z.array(z.string()).optional(),
  mode: z.enum(['paper', 'real']),
  status: z.enum(['draft', 'finance_review', 'owner_review', 'approved', 'denied', 'executed', 'expired']),
  checks: z
    .array(z.strictObject({ name: z.string().optional(), pass: z.boolean().optional(), detail: z.string().optional() }))
    .optional(),
  financeVerdict: z
    .strictObject({ decision: z.enum(['approve', 'deny', 'escalate']).optional(), reasons: z.array(z.string()).optional() })
    .optional(),
  approvalId: id.optional(),
  receipt: evidenceRef.optional(),
  expiresAt: ts.optional(),
  createdAt: ts,
});
export type SpendRequest = z.infer<typeof spendRequestSchema>;
