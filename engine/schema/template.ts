// Template manifest (`template.json`): an importable DATA package, never code (PHASE-1-PLAN 3.2, SPEC 26.6).
import { z } from 'zod';
import { jsonSchema, SLUG_RE } from './common.ts';

export const TEMPLATE_KINDS = [
  'department', 'team', 'role', 'agent', 'workflow', 'schedule', 'connection', 'providers', 'routing', 'policy', 'limits',
  'portfolio', 'skill', 'brain_note',
] as const;

/** Param names usable as `{{name}}` (and `{{name|slug}}`) in template files. */
export const PARAM_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
export const PARAM_TYPES = ['string', 'number', 'integer', 'boolean'] as const;

/**
 * Checks the declared params (a JSON Schema object: `properties.<name>.{type,default,enum,pattern,...}` + `required`).
 * Returns one message per problem. Used by the template schema; the importer uses the same declaration to type-check values.
 */
export function paramDeclarationIssues(params: Record<string, unknown>): { path: (string | number)[]; message: string }[] {
  const out: { path: (string | number)[]; message: string }[] = [];
  const add = (path: (string | number)[], message: string) => out.push({ path, message });
  if (params.type !== undefined && params.type !== 'object') add(['params', 'type'], "params must be a JSON Schema of type 'object'");
  const props = params.properties ?? {};
  if (typeof props !== 'object' || props === null || Array.isArray(props)) {
    add(['params', 'properties'], 'properties must be an object');
    return out;
  }
  for (const [name, decl] of Object.entries(props as Record<string, unknown>)) {
    const at = ['params', 'properties', name];
    if (!PARAM_NAME_RE.test(name)) add(at, `param name '${name}' must match ${PARAM_NAME_RE}`);
    const d = decl as Record<string, unknown> | null;
    if (typeof d !== 'object' || d === null || Array.isArray(d)) { add(at, 'a param declaration is an object'); continue; }
    const type = d.type;
    if (typeof type !== 'string' || !(PARAM_TYPES as readonly string[]).includes(type)) {
      add([...at, 'type'], `param type must be one of ${PARAM_TYPES.join(', ')}`);
      continue;
    }
    const ok = (v: unknown) => (type === 'integer' ? Number.isInteger(v) : typeof v === type);
    if ('default' in d && !ok(d.default)) add([...at, 'default'], `default is not of type ${type}`);
    if ('enum' in d) {
      if (!Array.isArray(d.enum) || d.enum.length === 0 || !d.enum.every(ok)) add([...at, 'enum'], `enum must be a non-empty list of ${type}`);
      else if ('default' in d && !d.enum.includes(d.default)) add([...at, 'default'], 'default is not in enum');
    }
    if ('pattern' in d) {
      try {
        new RegExp(String(d.pattern));
      } catch {
        add([...at, 'pattern'], 'pattern is not a valid regular expression');
      }
    }
  }
  if ('required' in params) {
    const req = params.required;
    if (!Array.isArray(req) || !req.every((r) => typeof r === 'string')) add(['params', 'required'], 'required must be a list of names');
    else req.forEach((r, i) => { if (!(r in (props as object))) add(['params', 'required', i], `required param '${r}' is not declared`); });
  }
  return out;
}

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
    if (t.params) for (const i of paramDeclarationIssues(t.params)) ctx.addIssue({ code: 'custom', path: i.path, message: i.message });
    t.files.forEach((f, i) => {
      if (!t.kinds.includes(f.kind)) {
        ctx.addIssue({ code: 'custom', path: ['files', i, 'kind'], message: `file kind '${f.kind}' is not declared in kinds` });
      }
    });
  });
export type Template = z.infer<typeof templateSchema>;
