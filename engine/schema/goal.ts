// Goal with Key Results (config kind `goal`, `org/goals/<id>.json`; SPEC 5, 8, S3).
import { z } from 'zod';
import { dataClass, SLUG_RE, ts } from './common.ts';

export const goalSchema = z
  .strictObject({
    id: z.string().regex(SLUG_RE),
    title: z.string().min(1).max(80),
    why: z.string().max(600).optional(),
    keyResults: z.array(
      z.strictObject({
        id: z.string().regex(SLUG_RE),
        metric: z.string().min(1),
        target: z.number(),
        current: z.number().optional(),
        source: z.string().min(1).describe('where the metric comes from, e.g. a connector analytics action'),
        due: ts.optional(),
        valuePerUnitUsd: z.number().min(0).optional().describe('S3: unset until the Owner sets it'),
      }),
    ),
    status: z.enum(['active', 'paused', 'done', 'killed']),
    dataClass: dataClass.optional(),
  })
  .superRefine((g, ctx) => {
    const seen = new Set<string>();
    g.keyResults.forEach((k, i) => {
      if (seen.has(k.id)) ctx.addIssue({ code: 'custom', path: ['keyResults', i, 'id'], message: `duplicate key result id '${k.id}'` });
      seen.add(k.id);
    });
  });
export type Goal = z.infer<typeof goalSchema>;
