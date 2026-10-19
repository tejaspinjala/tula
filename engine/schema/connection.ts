// Connection: one external account bound to exactly one Team (PHASE-1-PLAN 3.2, SPEC 28.3-28.6).
//
// A Connection holds secret REFERENCES only (Infisical project/environment/path/key), never values:
// - every ref field has a strict name format and is rejected if it looks like secret material
//   (known credential prefixes, PEM blocks, JWTs, long opaque tokens);
// - every other string anywhere in the object (account, config, health...) is scanned for known credential
//   patterns, so a pasted token in `config` is rejected too.
// Ref existence checks and resolution happen in execution services (P1-K2), never in fleetd.
import { z } from 'zod';
import {
  authMode, postingMode, rejectSecretValuesDeep, secretRefString, SLUG_RE, slug, ts,
} from './common.ts';

export const secretRef = z
  .strictObject({
    field: secretRefString(/^[a-z][a-z0-9_]{0,63}$/, 'field').describe('manifest requiredSecrets field name'),
    project: secretRefString(/^[a-z0-9][a-z0-9-]{0,63}$/, 'project'),
    environment: secretRefString(/^[a-z0-9][a-z0-9-]{0,31}$/, 'environment'),
    path: secretRefString(/^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/, 'path'),
    key: secretRefString(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, 'key'),
    check: z.enum(['unchecked', 'exists', 'missing', 'forbidden']).optional(),
    lastRotatedAt: ts.optional(),
  })
  .meta({ id: 'secretRef', description: 'A reference to a secret in Infisical. Never the value.' });
export type SecretRef = z.infer<typeof secretRef>;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');

export const connectionSchema = z
  .strictObject({
    id: z.string().regex(SLUG_RE),
    teamId: slug,
    connectorId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
    connectorVersion: z.string().min(1),
    account: z.strictObject({
      displayName: z.string().min(1),
      handle: z.string().optional(),
      url: z.url().optional(),
      owner: z.enum(['llc', 'personal']),
    }),
    auth: z.strictObject({
      mode: authMode,
      secretRefs: z.array(secretRef).optional(),
      identity: z.enum(['publisherd', 'paymentd']).optional().describe('execution service whose Infisical identity reads the refs'),
      profileId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/).optional()
        .describe('browser mode: encrypted profile owned by fleet-pub; one per connection'),
    }),
    posting: z.strictObject({
      mode: postingMode,
      dailyLimit: z.int().min(0),
      unavailableAfterHours: z.int().min(1).optional(),
      quietHours: z.strictObject({ from: hhmm.optional(), to: hhmm.optional(), tz: z.string().optional() }).optional(),
    }),
    config: z.record(z.string(), z.unknown()).optional().describe('validated against the connector manifest configSchema'),
    sharedWithTeams: z.array(slug).optional(),
    health: z
      .strictObject({
        status: z.enum(['ok', 'needs_login', 'rate_limited', 'error', 'unknown']).optional(),
        checkedAt: ts.optional(),
        detail: z.string().max(200).optional(),
      })
      .optional(),
    tosAcknowledgedAt: ts.optional(),
    status: z.enum(['active', 'disabled', 'pending_confirmation']),
  })
  .superRefine((c, ctx) => {
    rejectSecretValuesDeep(c, ctx);
    const refs = c.auth.secretRefs ?? [];
    if (c.auth.mode !== 'api' && refs.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['auth', 'secretRefs'], message: 'secretRefs are only used in api auth mode' });
    }
    if (c.auth.mode === 'api' && refs.length > 0 && !c.auth.identity) {
      ctx.addIssue({ code: 'custom', path: ['auth', 'identity'], message: 'api refs need the execution-service identity that reads them' });
    }
    if (c.auth.mode !== 'browser' && c.auth.profileId) {
      ctx.addIssue({ code: 'custom', path: ['auth', 'profileId'], message: 'profileId is only used in browser auth mode' });
    }
    const fields = refs.map((r) => r.field);
    if (new Set(fields).size !== fields.length) {
      ctx.addIssue({ code: 'custom', path: ['auth', 'secretRefs'], message: 'duplicate secret field' });
    }
    if ((c.sharedWithTeams ?? []).includes(c.teamId)) {
      ctx.addIssue({ code: 'custom', path: ['sharedWithTeams'], message: 'the owning team is not listed in sharedWithTeams' });
    }
  });
export type Connection = z.infer<typeof connectionSchema>;
