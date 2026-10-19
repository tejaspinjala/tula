// Role: a job template (config kind `role`, `org/roles/<id>.json`; SPEC 5). Prompts, tools, scopes and tiers
// are data. "tier ≤ maxTier" is checked here; "node tierOverride ≤ maxTier" is the validator's (P1-W1).
import { z } from 'zod';
import { SLUG_RE, scope, slug, tier, TIER_RANK, usd } from './common.ts';

export const roleSchema = z
  .strictObject({
    id: z.string().regex(SLUG_RE),
    title: z.string().min(1).max(60),
    level: z.int().min(0).max(4).describe('0 owner seat, 1 director, 2 manager, 3 employee, 4 helper'),
    dutiesPrompt: z.string().min(1).max(8000),
    tier: tier.describe('default tier'),
    maxTier: tier.describe('highest tier a workflow node may request for this role'),
    nativeTools: z.array(z.string()),
    gatewayTools: z.array(z.string()),
    scope: scope.describe('read/write paths, shell prefixes, domains, data classes, budgets'),
    skills: z.array(z.string()).optional(),
    maxTurns: z.int().min(1).max(500),
    maxRunUsd: usd,
    omitProjectInstructions: z.boolean().optional(),
    goldenTasks: z.array(z.string()).optional(),
    canBeVerifierFor: z.array(slug).optional(),
  })
  .superRefine((r, ctx) => {
    if (TIER_RANK[r.tier] > TIER_RANK[r.maxTier]) {
      ctx.addIssue({ code: 'custom', path: ['tier'], message: 'default tier is above maxTier' });
    }
  });
export type Role = z.infer<typeof roleSchema>;
