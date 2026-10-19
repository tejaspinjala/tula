// ConfigVersion: index entry for every config change; the git commit holds the content (PHASE-1-PLAN 3.2,
// SPEC 26.4).
import { z } from 'zod';
import { sha256, ts } from './common.ts';

export const configVersionSchema = z
  .strictObject({
    kind: z.string().regex(/^[a-z][a-z0-9-]*$/),
    id: z.string().min(1),
    version: z.int().min(1),
    hash: sha256,
    commit: z.string().regex(/^[a-f0-9]{7,64}$/).optional(),
    actor: z
      .string()
      .regex(/^(owner|file|template:[a-z0-9][a-z0-9-]{1,63}|[a-z0-9][a-z0-9-]{1,63})$/)
      .describe("'owner' | 'file' | 'template:<id>' | agentId (proposals only)"),
    ts,
    status: z.enum(['active', 'pending_confirmation', 'rejected', 'superseded']),
    riskWidening: z.boolean(),
    reasons: z.array(z.string()).optional(),
    effective: z.enum(['now', 'next_run']).optional(),
    confirmedAt: ts.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.riskWidening && (v.reasons ?? []).length === 0) {
      ctx.addIssue({ code: 'custom', path: ['reasons'], message: 'a risk-widening change lists its reasons' });
    }
    if (v.status === 'active' && v.riskWidening && !v.confirmedAt) {
      ctx.addIssue({ code: 'custom', path: ['confirmedAt'], message: 'an active risk-widening change needs owner confirmation' });
    }
  });
export type ConfigVersion = z.infer<typeof configVersionSchema>;
