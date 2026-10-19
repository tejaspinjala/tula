// Providers (config kind `providers`, `org/providers.json`; SPEC 4.8, S6, S12).
//
// OWNER-LOCKED FIELD: `providers.<id>.privateEligible`. It is annotated `x-ownerLocked: true` in the exported
// JSON Schema (see OWNER_LOCKED_FIELDS). Agents, workflows and template imports can never set it; enabling it
// is risk-widening (owner re-auth + typed confirmation). That enforcement lives in the config service (P1-C)
// and the loader (P0-6); this schema only models the field. The fail-closed mechanism stays in code.
import { z } from 'zod';
import { dataClass, secretPathRef, tier, TIERS } from './common.ts';

export const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
/** Failover chain entry: a provider id, a group (`@any-api`, `@local`) or `PAUSE`. */
export const CHAIN_ENTRY_RE = /^(?:[a-z0-9][a-z0-9-]{1,40}|@any-api|@local|PAUSE)$/;

export const privateEligible = z.boolean().meta({
  'x-ownerLocked': true,
  description:
    'OWNER-LOCKED. May this provider receive private-class data? Only the Owner may change it; enabling is risk-widening (SPEC 4.8, 26.3).',
});

export const provider = z
  .strictObject({
    adapter: z.enum(['claude-code', 'codex', 'fleet-loop']),
    family: z.string().min(1).optional().describe('model family for judge independence; "mixed" for routers'),
    auth: z.enum(['subscription', 'api_key', 'none']).optional(),
    baseUrl: z.url().optional(),
    secretRef: secretPathRef.optional().describe('Infisical path of the API key; never the key'),
    tiers: z.partialRecord(tier, z.string().min(1)),
    dataClasses: z.array(dataClass),
    privateEligible,
    disabled: z.boolean().optional(),
  })
  .superRefine((p, ctx) => {
    if (p.dataClasses.includes('secret')) {
      ctx.addIssue({ code: 'custom', path: ['dataClasses'], message: "the 'secret' class never goes to a provider" });
    }
    if (p.dataClasses.includes('private') && !p.privateEligible) {
      ctx.addIssue({ code: 'custom', path: ['dataClasses'], message: "'private' in dataClasses requires privateEligible" });
    }
    if (p.adapter === 'fleet-loop' && !p.baseUrl) {
      ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: 'a fleet-loop provider needs a baseUrl' });
    }
  })
  .meta({ id: 'provider' });
export type Provider = z.infer<typeof provider>;

const chain = z.array(z.string().regex(CHAIN_ENTRY_RE)).min(1);

export const providersSchema = z
  .strictObject({
    providers: z.record(z.string().regex(PROVIDER_ID_RE), provider),
    failover: z.partialRecord(tier, chain),
    classChains: z.strictObject({ private: chain.optional() }).optional()
      .describe('per data class chains; private is filtered by privateEligible and never falls through'),
    taskOverrides: z
      .record(z.string().min(1), z.strictObject({ preferFamilyOtherThan: z.string().min(1).optional() }))
      .optional(),
    prices: z
      .record(
        z.string().min(1),
        z.strictObject({
          inUsdPerMtok: z.number().min(0).optional(),
          outUsdPerMtok: z.number().min(0).optional(),
          cacheReadUsdPerMtok: z.number().min(0).optional(),
          usdPerQuotaUnit: z.number().min(0).optional().describe('subscription providers: API-equivalent USD per quota unit'),
        }),
      )
      .optional()
      .describe('per-model prices'),
  })
  .superRefine((cfg, ctx) => {
    const ids = new Set(Object.keys(cfg.providers));
    const checkChain = (entries: string[] | undefined, path: (string | number)[]) =>
      (entries ?? []).forEach((e, i) => {
        if (!e.startsWith('@') && e !== 'PAUSE' && !ids.has(e)) {
          ctx.addIssue({ code: 'custom', path: [...path, i], message: `unknown provider '${e}' in chain` });
        }
      });
    for (const t of TIERS) checkChain(cfg.failover[t], ['failover', t]);
    checkChain(cfg.classChains?.private, ['classChains', 'private']);
  });
export type Providers = z.infer<typeof providersSchema>;

/** JSON-pointer-ish paths of owner-locked fields, for the config service and the UI. */
export const OWNER_LOCKED_FIELDS = ['providers/*/privateEligible'] as const;
