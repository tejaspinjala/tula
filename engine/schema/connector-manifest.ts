// ConnectorManifest: platform support declared as data (PHASE-1-PLAN 3.2, SPEC 28.7-28.8).
import { z } from 'zod';
import { authMode, jsonSchema, sha256, tosRisk } from './common.ts';

export const connectorAction = z
  .strictObject({
    id: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, 'action ids look like post.create'),
    title: z.string().min(1),
    effect: z.enum(['read', 'write_internal', 'write_external']),
    authModes: z.array(authMode),
    inputSchema: jsonSchema,
    outputSchema: jsonSchema,
    rateLimit: z.strictObject({ perHour: z.int().min(0).optional(), perDay: z.int().min(0).optional() }).optional(),
    status: z.enum(['available', 'planned']),
  })
  .meta({ id: 'connectorAction' });
export type ConnectorAction = z.infer<typeof connectorAction>;

export const connectorManifestSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'semver'),
    platform: z.string().min(1),
    description: z.string().max(300).optional(),
    authModes: z.array(authMode).min(1),
    configSchema: jsonSchema,
    requiredSecrets: z
      .partialRecord(authMode, z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)))
      .optional()
      .describe('per auth mode: list of secret field names'),
    actions: z.array(connectorAction),
    healthCheck: z
      .strictObject({
        everyMin: z.int().min(1).optional(),
        kind: z.enum(['api_ping', 'browser_logged_in', 'none']).optional(),
      })
      .optional(),
    tosRisk: z.partialRecord(authMode, tosRisk).describe('per auth mode'),
    netDomains: z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).optional(),
    trust: z.enum(['builtin', 'signed', 'unsigned']),
    signature: z.string().optional(),
    contentHash: sha256.optional(),
  })
  .superRefine((m, ctx) => {
    const modes = new Set(m.authModes);
    const seen = new Set<string>();
    m.actions.forEach((a, i) => {
      if (seen.has(a.id)) ctx.addIssue({ code: 'custom', path: ['actions', i, 'id'], message: `duplicate action id '${a.id}'` });
      seen.add(a.id);
      a.authModes.forEach((mode, j) => {
        if (!modes.has(mode)) {
          ctx.addIssue({ code: 'custom', path: ['actions', i, 'authModes', j], message: `auth mode '${mode}' is not in the manifest authModes` });
        }
      });
    });
    for (const mode of m.authModes) {
      if (!m.tosRisk[mode]) ctx.addIssue({ code: 'custom', path: ['tosRisk'], message: `tosRisk missing for auth mode '${mode}'` });
    }
    if (m.trust === 'signed' && (!m.signature || !m.contentHash)) {
      ctx.addIssue({ code: 'custom', path: ['signature'], message: 'a signed connector needs signature and contentHash' });
    }
  });
export type ConnectorManifest = z.infer<typeof connectorManifestSchema>;
