// Limits (config kind `limits`, `org/limits.json`; SPEC 7.2, 8.2, S10). Raising any value is risk-widening
// (SPEC 26.3), enforced by the config service.
import { z } from 'zod';
import { tier, usd } from './common.ts';

export const limitsSchema = z.strictObject({
  dailyTokenCapUsd: usd.describe('company-wide API-equivalent token spend per day'),
  maxRunUsd: z.partialRecord(tier, usd).describe('per-Run cap by tier'),
  meetingCapUsd: usd,
  wip: z.strictObject({
    projectsPerGoal: z.int().min(1),
    runningTasksPerGoal: z.int().min(1),
    runningTasksCompany: z.int().min(1),
  }),
  maxConcurrentExperiments: z.int().min(0),
  handoffCtxPct: z.number().min(5).max(95).describe('context % at which a Run hands off and restarts'),
  browserStepCap: z.int().min(1).optional(),
});
export type Limits = z.infer<typeof limitsSchema>;
