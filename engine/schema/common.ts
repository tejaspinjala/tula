// Shared building blocks for every schema in engine/schema/. Zod here is canonical; the JSON Schema in
// engine/schema/json/ is generated from it (`bun run schema:export`).
//
// Schemas that carry a metadata `id` (via `.meta({ id })`) are emitted as `$defs/<id>` in every JSON Schema
// file that uses them, so the exported files are self-contained (no cross-file $refs).
import { z } from 'zod';

/**
 * Entity id format. MUST match the output of `newId()` in engine/lib/ids.ts (owned by slice P0-3):
 * `<prefix>_<26 chars Crockford base32>`, prefix `^[a-z][a-z0-9]{0,15}$`. Not imported on purpose: the
 * schema package has no runtime dependency on engine/lib. tests/unit/schema/ids-consistency.test.ts checks
 * the two agree whenever engine/lib/ids.ts is present.
 */
export const ID_RE = /^[a-z][a-z0-9]{0,15}_[0-9A-HJKMNP-TV-Z]{26}$/;

/** Ids of configuration objects (workflows, teams, connections, templates, roles, agents...). */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

export const id = z.string().regex(ID_RE).meta({
  id: 'id',
  description: 'Entity id: <prefix>_<26 Crockford base32>, as produced by engine/lib/ids.ts newId()',
});

export const slug = z.string().regex(SLUG_RE).meta({
  id: 'slug',
  description: 'Configuration object id: lowercase letters, digits and dashes, 2-64 chars',
});

export const ts = z.iso.datetime({ offset: true }).meta({ id: 'ts', description: 'RFC 3339 date-time' });

export const TIERS = ['cheap', 'mid', 'deep'] as const;
export const tier = z.enum(TIERS).meta({ id: 'tier' });
export type Tier = z.infer<typeof tier>;

/** Tier order for "≤ max tier" checks. */
export const TIER_RANK: Record<Tier, number> = { cheap: 0, mid: 1, deep: 2 };

export const DATA_CLASSES = ['public', 'internal', 'private', 'secret'] as const;
export const dataClass = z.enum(DATA_CLASSES).meta({ id: 'dataClass' });
export type DataClass = z.infer<typeof dataClass>;

export const sha256 = z.string().regex(/^[a-f0-9]{64}$/).meta({ id: 'sha256' });

export const usd = z.number().min(0).meta({ id: 'usd' });

/** Autonomy levels usable in config. L4 is reserved by SPEC section 9 and not accepted anywhere. */
export const AUTONOMY_LEVELS = ['L0', 'L1', 'L2', 'L3'] as const;
export const autonomy = z.enum(AUTONOMY_LEVELS).meta({ id: 'autonomy' });

export const AUTH_MODES = ['api', 'browser', 'manual'] as const;
export const authMode = z.enum(AUTH_MODES).meta({ id: 'authMode' });

export const POSTING_MODES = ['manual', 'approve_then_auto', 'auto_when_unavailable', 'auto'] as const;
export const postingMode = z.enum(POSTING_MODES).meta({ id: 'postingMode' });

export const TOS_RISKS = ['low', 'medium', 'high'] as const;
export const tosRisk = z.enum(TOS_RISKS).meta({ id: 'tosRisk' });

/** An embedded JSON Schema document (params, outputSchema, configSchema...). Only "is an object" is checked here. */
export const jsonSchema = z.record(z.string(), z.unknown()).meta({
  id: 'jsonSchema',
  description: 'An embedded JSON Schema document',
});

export const scope = z
  .strictObject({
    read: z.array(z.string()).optional(),
    write: z.array(z.string()).optional(),
    shell: z.array(z.string()).optional().describe('allowed command prefixes'),
    gatewayTools: z.array(z.string()).optional(),
    nativeTools: z.array(z.string()).optional(),
    netDomains: z.array(z.string()).optional(),
    dataClasses: z.array(dataClass).optional(),
    usd: usd.optional(),
    tokens: z.int().min(0).optional(),
  })
  .meta({ id: 'scope' });
export type Scope = z.infer<typeof scope>;

export const EVIDENCE_KINDS = [
  'test_output', 'command_log', 'commit', 'screenshot', 'video', 'file_line', 'url', 'metric', 'brain_note',
] as const;

export const evidenceRef = z
  .strictObject({
    kind: z.enum(EVIDENCE_KINDS),
    ref: z.string().min(1),
    sha256: sha256.optional(),
    note: z.string().max(300).optional(),
  })
  .meta({ id: 'evidenceRef' });
export type EvidenceRef = z.infer<typeof evidenceRef>;

export const doneCondition = z
  .strictObject({
    kind: z.enum(['command', 'tests', 'schema', 'rubric']),
    spec: z.string().min(1),
    timeoutSec: z.int().min(1).default(300),
  })
  .meta({ id: 'doneCondition' });
export type DoneCondition = z.infer<typeof doneCondition>;

// ---------------------------------------------------------------------------------------------------------
// Secret material detection. Config may hold secret REFERENCES (Infisical project/env/path/key), never values.
// These patterns are deliberately high precision; the "opaque token" heuristic is applied only to fields that
// are supposed to be short reference names, where a long mixed-case alphanumeric run is never legitimate.

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, // PEM private keys
  /\bsk-(?:ant-|proj-|or-|live-|test-)?[A-Za-z0-9_-]{16,}/, // Anthropic / OpenAI / OpenRouter / Stripe style
  /\b(?:rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/, // Stripe keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}/, // Google API key
  /\bya29\.[A-Za-z0-9_-]{20,}/, // Google OAuth access token
  /(?:^|[^A-Za-z0-9])1\/\/[A-Za-z0-9_-]{30,}/, // Google OAuth refresh token
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWT
  /\bst\.[A-Za-z0-9-]{8,}\.[A-Za-z0-9]{16,}/, // Infisical service token
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S{6,}/i, // key=value assignments
];

/** True when `s` contains something that looks like a credential value (not a reference to one). */
export function containsSecretValue(s: string): boolean {
  return SECRET_VALUE_PATTERNS.some((re) => re.test(s));
}

/** True for a long opaque token: ≥ 24 chars of base64/hex-ish characters mixing letters and digits. */
export function looksLikeOpaqueToken(s: string): boolean {
  for (const run of s.match(/[A-Za-z0-9+/=_-]{24,}/g) ?? []) {
    const hasLetter = /[A-Za-z]/.test(run);
    const hasDigit = /[0-9]/.test(run);
    const words = run.split(/[_/-]/).filter(Boolean);
    const longestWord = Math.max(...words.map((w) => w.length));
    // SCREAMING_SNAKE names and kebab paths are made of short words; a token is one long unbroken word.
    if (hasLetter && hasDigit && longestWord >= 20) return true;
  }
  return false;
}

export const SECRET_REF_MESSAGE = 'must be a secret reference (name/path), not secret material';

/** A string that names a secret (e.g. an Infisical path or key); rejects anything that looks like the value. */
export function secretRefString(re: RegExp, what: string) {
  return z
    .string()
    .regex(re, `${what} has an invalid format`)
    .refine((s) => !containsSecretValue(s) && !looksLikeOpaqueToken(s), { message: SECRET_REF_MESSAGE });
}

/** Infisical-style secret path reference, e.g. `providers/OPENROUTER_API_KEY` or `/channels/linkedin/HMAC`. */
export const SECRET_PATH_RE = /^\/?[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*$/;
export const secretPathRef = secretRefString(SECRET_PATH_RE, 'secret path');

/** Walks every string in `value` and reports a Zod issue for each one that contains a secret value. */
export function rejectSecretValuesDeep(value: unknown, ctx: z.RefinementCtx, path: (string | number)[] = []): void {
  if (typeof value === 'string') {
    if (containsSecretValue(value)) {
      ctx.addIssue({ code: 'custom', path, message: 'secret material is never stored in config; use a secret reference' });
    }
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => rejectSecretValuesDeep(v, ctx, [...path, i]));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) rejectSecretValuesDeep(v, ctx, [...path, k]);
  }
}

/** Library export: emitted as common.schema.json `$defs` (this module has no entity schema of its own). */
export const commonDefs = {
  id, slug, ts, tier, dataClass, sha256, usd, autonomy, authMode, postingMode, tosRisk, jsonSchema, scope,
  evidenceRef, doneCondition,
} as const;
