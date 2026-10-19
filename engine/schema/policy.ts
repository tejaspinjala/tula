// Policy (config kind `policy`, `org/policy.json`; SPEC 7.4, 9, 26.2). Approval thresholds, autonomy rules
// and tripwires are values; the mechanisms (gates, fail closed, kill) stay in code.
import { z } from 'zod';
import { AUTONOMY_LEVELS, usd } from './common.ts';

const approver = z.enum(['owner', 'finance', 'finance_auto']);
const level = z.enum(AUTONOMY_LEVELS);

export const policySchema = z
  .strictObject({
    spendApprovals: z
      .array(
        z.strictObject({
          id: z.string().min(1),
          match: z.enum(['one_off', 'recurring', 'new_vendor']),
          minUsd: usd.optional(),
          maxUsd: usd.optional(),
          approverByAutonomy: z.partialRecord(level, approver),
        }),
      )
      .min(1),
    dailySpendCapUsdByAutonomy: z.partialRecord(level, usd),
    financeAutoApproveMaxUsd: usd.describe('Finance may approve paper spends up to this amount after deterministic checks'),
    externalActionApprover: z.literal('owner').describe('every external action goes to the Owner unless a connection posting mode permits auto'),
    autonomy: z.strictObject({
      default: level,
      maxWithoutPasskey: level,
      autoPostingRequires: level.describe('posting modes above manual need at least this department level'),
    }),
    tripwires: z.strictObject({
      tokenBurnMultiplier: z.number().gt(1).describe('× the 7-day median per hour'),
      gateDenialsPerHour: z.int().min(1),
    }),
  })
  .superRefine((p, ctx) => {
    p.spendApprovals.forEach((r, i) => {
      if (r.minUsd !== undefined && r.maxUsd !== undefined && r.minUsd > r.maxUsd) {
        ctx.addIssue({ code: 'custom', path: ['spendApprovals', i, 'maxUsd'], message: 'maxUsd is below minUsd' });
      }
    });
  });
export type Policy = z.infer<typeof policySchema>;
