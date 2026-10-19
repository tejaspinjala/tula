// Scorecard: per-Run metrics (PHASE-1-PLAN 3.1).
import { z } from 'zod';
import { id } from './common.ts';

const count = z.int().min(0);

export const scorecardSchema = z.strictObject({
  runId: id,
  taskId: id.optional(),
  goalId: z.string().optional(),
  agentId: z.string().min(1),
  roleId: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  tokensIn: count,
  tokensOut: count,
  cacheRead: count.optional(),
  costUsd: z.number().min(0),
  quotaUnits: z.number().min(0).optional(),
  turns: count,
  wallMs: count,
  peakCtxPct: z.number().min(0).max(100),
  retries: count.optional(),
  gateDenials: count.optional(),
  accessRequests: count.optional(),
  helperCount: count.optional(),
  loopFlags: z.array(z.enum(['stuck', 'loop', 'ctx_over', 'gate_thrash', 'waste'])).optional(),
  acceptanceMet: z.boolean().optional(),
  verdict: z.enum(['pass', 'fail']).optional(),
  judgeIndependence: z.enum(['strong', 'weak']).optional(),
  reworkOf: id.optional(),
  failover: z.boolean().optional(),
  outcome: z.enum(['ok', 'failed', 'handoff', 'killed', 'failover']),
});
export type Scorecard = z.infer<typeof scorecardSchema>;
