// AccessRequest: asks for a missing Scope. PHASE-1-PLAN 3.1 defines it as "the AccessGrant shape, with
// status requested|granted|escalated|denied|expired and no grantedBy". `requestId` and
// `granterAuthorityHash` belong to the grant side and are dropped too; `grantId` links the resulting grant.
import { z } from 'zod';
import { id, scope, ts } from './common.ts';

export const accessRequestSchema = z.strictObject({
  id,
  agentId: z.string().min(1),
  runId: id.optional(),
  taskId: id.optional(),
  scope,
  escalationPath: z.array(z.string()).optional(),
  reason: z.string().min(1).max(300),
  status: z.enum(['requested', 'granted', 'escalated', 'denied', 'expired']),
  maxUses: z.int().min(1).optional(),
  grantId: id.optional(),
  createdAt: ts,
  expiresAt: ts,
});
export type AccessRequest = z.infer<typeof accessRequestSchema>;
