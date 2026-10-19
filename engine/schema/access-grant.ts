// AccessGrant: a narrow, time-boxed Scope (PHASE-1-PLAN 3.1). Subset-of-granter is enforced by P1-3 policy.
import { z } from 'zod';
import { id, scope, sha256, ts } from './common.ts';

export const accessGrantSchema = z.strictObject({
  id,
  requestId: id,
  agentId: z.string().min(1),
  runId: id.optional(),
  taskId: id.optional(),
  scope,
  grantedBy: z.string().min(1).describe("agentId | 'policy:auto' | 'owner'"),
  granterAuthorityHash: sha256.describe("hash of granter's effective scope at grant time; grant must be a subset"),
  escalationPath: z.array(z.string()).optional(),
  reason: z.string().min(1).max(300),
  status: z.enum(['active', 'expired', 'revoked']),
  maxUses: z.int().min(1).optional(),
  createdAt: ts,
  expiresAt: ts,
});
export type AccessGrant = z.infer<typeof accessGrantSchema>;
