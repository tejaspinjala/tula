// Portfolio (config kind `portfolio`, `org/portfolio.json`; SPEC 5, 8.2-8.3, S1, S2). A singleton.
import { z } from 'zod';
import { slug, ts } from './common.ts';

const share = z.number().min(0).max(1);

export const portfolioSchema = z
  .strictObject({
    goals: z.array(
      z.strictObject({
        goalId: z.string().min(1),
        budgetShare: share,
        tokenShare: share,
        floorShare: share,
        wipLimit: z.strictObject({ projects: z.int().min(0), runningTasks: z.int().min(0) }),
      }),
    ),
    personal: z
      .strictObject({ tokenShare: share, departmentIds: z.array(slug) })
      .optional()
      .describe('S2: fixed token share for personal departments, outside ROI reallocation'),
    reallocateEvery: z.literal('weekly'),
    maxShiftPerWeek: share,
    graceWeeks: z.int().min(0),
    lastReview: ts.optional(),
  })
  .superRefine((p, ctx) => {
    const sum = (k: 'budgetShare' | 'tokenShare') => p.goals.reduce((a, g) => a + g[k], 0);
    const eps = 1e-9;
    if (sum('budgetShare') > 1 + eps) ctx.addIssue({ code: 'custom', path: ['goals'], message: 'budget shares sum above 1' });
    if (sum('tokenShare') + (p.personal?.tokenShare ?? 0) > 1 + eps) {
      ctx.addIssue({ code: 'custom', path: ['goals'], message: 'token shares (incl. personal) sum above 1' });
    }
    p.goals.forEach((g, i) => {
      if (g.floorShare > g.budgetShare) ctx.addIssue({ code: 'custom', path: ['goals', i, 'floorShare'], message: 'floor above budget share' });
    });
  });
export type Portfolio = z.infer<typeof portfolioSchema>;
