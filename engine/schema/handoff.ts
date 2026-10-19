// Handoff: the required structured note at the end of every Run (PHASE-1-PLAN 3.1).
import { z } from 'zod';
import { doneCondition, evidenceRef, id, sha256, ts } from './common.ts';

export const handoffSchema = z
  .strictObject({
    runId: id,
    taskId: id,
    owner: z.string().min(1),
    inputs: z.array(z.string()),
    doneCondition,
    status: z.enum(['met', 'not_met', 'partial']),
    summary: z.string().max(1200).optional(),
    evidence: z.array(evidenceRef),
    decisions: z.array(z.string().max(300)).optional(),
    changed: z
      .strictObject({
        files: z.array(z.string()).optional(),
        commit: z.string().optional(),
        contentHash: sha256.optional(),
      })
      .optional(),
    next: z.array(z.string()),
    unverified: z.array(z.string()).optional(),
    peakCtxPct: z.number().min(0).max(100).optional(),
    trust: z.enum(['agent', 'auto']),
    writtenAt: ts,
  })
  .superRefine((h, ctx) => {
    if (h.status === 'met' && h.evidence.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['evidence'], message: "status 'met' needs at least one evidence item" });
    }
  });
export type Handoff = z.infer<typeof handoffSchema>;
