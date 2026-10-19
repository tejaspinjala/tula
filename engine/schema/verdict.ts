// Verdict: the coordinator's pass/fail on one Proposal hash (PHASE-1-PLAN 3.1).
import { z } from 'zod';
import { evidenceRef, id, ts } from './common.ts';

export const verdictSchema = z
  .strictObject({
    id,
    taskId: id,
    proposalHash: z.string().min(1),
    verifierRunId: id,
    judgeRunId: id.optional(),
    judgeFamily: z.string().optional(),
    independence: z.enum(['strong', 'weak']),
    decision: z.enum(['pass', 'fail']),
    reasons: z.array(z.string()),
    findings: z
      .array(
        z.strictObject({
          ruleKey: z.string().min(1),
          severity: z.enum(['info', 'minor', 'major', 'blocker']),
          text: z.string().min(1),
          ref: z.string().optional(),
        }),
      )
      .optional(),
    evidence: z.array(evidenceRef).optional(),
    issuedBy: z.string().min(1),
    issuedAt: ts,
  })
  .superRefine((v, ctx) => {
    if (v.decision === 'pass' && (v.findings ?? []).some((f) => f.severity === 'blocker')) {
      ctx.addIssue({ code: 'custom', path: ['decision'], message: 'a pass verdict cannot carry a blocker finding' });
    }
  });
export type Verdict = z.infer<typeof verdictSchema>;
