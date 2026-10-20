import { z } from 'zod'

/** Settings that must be explicit in production and have development defaults elsewhere. */
const productionFields = {
  /** Deployment mode; `production` turns on the boot-time safety checks below. */
  NODE_ENV: z.string().default('development'),
  /** WebAuthn relying-party id: the domain passkeys are scoped to. */
  WEBAUTHN_RP_ID: z.string().min(1).optional(),
  /** Exact origin the ledger view is served from. */
  WEBAUTHN_ORIGIN: z.url().optional(),
}

const DEV_RP_ID = 'localhost'
const DEV_ORIGIN = 'http://localhost:5173'

/** Fails in production unless the relying party is explicit; fills development defaults. */
function relyingParty(
  env: {
    NODE_ENV: string
    WEBAUTHN_RP_ID?: string | undefined
    WEBAUTHN_ORIGIN?: string | undefined
  },
  ctx: z.RefinementCtx
) {
  if (env.NODE_ENV === 'production') {
    for (const key of ['WEBAUTHN_RP_ID', 'WEBAUTHN_ORIGIN'] as const) {
      if (!env[key]) {
        ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required in production` })
      }
    }
  }
}

const baseSchema = z.object({
  ...productionFields,
  /** Non-owner `guildhall_app` connection: the only one the running app uses. */
  APP_DATABASE_URL: z.url(),
  /** Trust `x-guild-id` as the caller's guild. Development only, until authentication lands. */
  DEV_GUILD_HEADER: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** S3-compatible object storage for artifacts (MinIO in development). */
  OBJECT_STORE_ENDPOINT: z.url().default('http://localhost:9000'),
  OBJECT_STORE_BUCKET: z.string().min(3).default('guildhall-artifacts'),
  OBJECT_STORE_ACCESS_KEY: z.string().min(1),
  OBJECT_STORE_SECRET_KEY: z.string().min(1),
  /** Create the bucket at boot if missing: development and tests only. */
  OBJECT_STORE_CREATE_BUCKET: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Local file holding the audit-chain master key (created 0600 if missing); never in Postgres. */
  KEY_FILE: z.string().min(1).default('.guildhall/master.key'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
})

const schema = baseSchema
  .superRefine((env, ctx) => {
    relyingParty(env, ctx)
    if (env.NODE_ENV === 'production' && env.DEV_GUILD_HEADER) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEV_GUILD_HEADER'],
        message: 'DEV_GUILD_HEADER must not be true in production',
      })
    }
  })
  .transform((env) => ({
    ...env,
    WEBAUTHN_RP_ID: env.WEBAUTHN_RP_ID ?? DEV_RP_ID,
    WEBAUTHN_ORIGIN: env.WEBAUTHN_ORIGIN ?? DEV_ORIGIN,
  }))

/** Validated process environment for guildd. */
export type Env = z.infer<typeof schema>

/** Parses the environment, throwing at boot on anything invalid. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return schema.parse(source)
}

const webauthnSchema = z
  .object(productionFields)
  .superRefine(relyingParty)
  .transform((env) => ({
    WEBAUTHN_RP_ID: env.WEBAUTHN_RP_ID ?? DEV_RP_ID,
    WEBAUTHN_ORIGIN: env.WEBAUTHN_ORIGIN ?? DEV_ORIGIN,
  }))

/** Parses only the WebAuthn relying-party settings; explicit in production, defaulted elsewhere. */
export function loadWebauthnEnv(source: Record<string, string | undefined> = process.env) {
  return webauthnSchema.parse(source)
}
