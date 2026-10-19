// Run: one execution of one Agent on one Brief on one provider/model (PHASE-1-PLAN 3.1).
import { z } from 'zod';
import { dataClass, id, slug, tier, ts } from './common.ts';

export const runSchema = z.strictObject({
  id,
  taskId: id,
  agentId: slug,
  roleId: slug,
  purpose: z.enum(['implement', 'verify', 'judge', 'coordinate', 'intake', 'compile', 'meeting_turn', 'other']).optional(),
  adapter: z.enum(['claude-code', 'codex', 'fleet-loop']),
  provider: z.string().min(1),
  family: z.string().min(1),
  model: z.string().min(1),
  tier,
  dataClasses: z.array(dataClass).optional(),
  status: z.enum(['starting', 'running', 'ok', 'failed', 'handoff', 'killed', 'failover']),
  resumeFrom: z.string().optional().describe('handoff path'),
  briefPath: z.string().min(1),
  handoffPath: z.string().optional(),
  decisionLogPath: z.string().optional(),
  scopeTokenId: z.string().min(1),
  worktree: z.string().optional(),
  osUser: z.string().optional(),
  error: z
    .strictObject({
      class: z.enum(['rate_limit', 'credits_exhausted', 'overloaded', 'auth', 'context', 'tool', 'other']).optional(),
      message: z.string().max(500).optional(),
    })
    .optional(),
  startedAt: ts,
  endedAt: ts.optional(),
});
export type Run = z.infer<typeof runSchema>;
