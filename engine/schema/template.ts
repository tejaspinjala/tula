// Template manifest (`template.json`): an importable DATA package, never code (PHASE-1-PLAN 3.2, SPEC 26.6).
import { z } from 'zod';
import { jsonSchema, SLUG_RE } from './common.ts';

export const TEMPLATE_KINDS = [
  'department', 'team', 'role', 'agent', 'workflow', 'schedule', 'connection', 'providers', 'routing', 'policy', 'limits',
  'portfolio', 'skill', 'brain_note',
] as const;

export const templateSchema = z
  .strictObject({
    id: z.string().regex(SLUG_RE),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'semver'),
    title: z.string().optional(),
    description: z.string().max(500).optional(),
    kinds: z.array(z.enum(TEMPLATE_KINDS)),
    requires: z.strictObject({
      schemaVersion: z.string().optional(),
      connectors: z.array(z.string()).optional(),
      templates: z.array(z.string()).optional(),
    }),
    params: jsonSchema.optional().describe('JSON Schema for import params'),
    files: z.array(
      z.strictObject({
        kind: z.enum(TEMPLATE_KINDS),
        path: z
          .string()
          .min(1)
          .refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), { message: 'path must be relative and stay inside the package' }),
      }),
    ),
    riskWidening: z.boolean().optional().describe('computed on import; informational in the file'),
  })
  .superRefine((t, ctx) => {
    t.files.forEach((f, i) => {
      if (!t.kinds.includes(f.kind)) {
        ctx.addIssue({ code: 'custom', path: ['files', i, 'kind'], message: `file kind '${f.kind}' is not declared in kinds` });
      }
    });
  });
export type Template = z.infer<typeof templateSchema>;
