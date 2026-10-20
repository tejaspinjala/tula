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
const DEV_KEY_FILE = '.guildhall/master.key'
const DEV_CHECKPOINT_DIR = '.guildhall/checkpoints'

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

/** A base64url string that decodes to exactly `length` bytes, optionally starting with `first`. */
function base64urlBytes(length: number, first?: number) {
  return z.string().refine((value) => {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
      return false
    }
    const bytes = Buffer.from(value, 'base64url')
    return bytes.length === length && (first === undefined || bytes[0] === first)
  }, `must be base64url of ${length} bytes`)
}

const vapidFields = {
  /** VAPID public key for web push: base64url of the 65-byte uncompressed P-256 point. */
  VAPID_PUBLIC_KEY: base64urlBytes(65, 0x04).optional(),
  /** VAPID private key: base64url of the 32-byte P-256 scalar. Secret. */
  VAPID_PRIVATE_KEY: base64urlBytes(32).optional(),
  /** VAPID contact the push service may reach: a `mailto:` or `https:` URL. */
  VAPID_SUBJECT: z
    .string()
    .regex(/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/)
    .optional(),
}

const VAPID_KEYS = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'] as const

/** Web push needs all three VAPID settings: required in production, all-or-none elsewhere. */
function vapid(
  env: { NODE_ENV: string } & Partial<Record<(typeof VAPID_KEYS)[number], string | undefined>>,
  ctx: z.RefinementCtx
) {
  const required = env.NODE_ENV === 'production'
  const present = VAPID_KEYS.filter((key) => env[key])
  if (!required && present.length === 0) {
    return
  }
  for (const key of VAPID_KEYS) {
    if (!env[key]) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `${key} is required ${required ? 'in production' : 'when any VAPID setting is set'}`,
      })
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
  /**
   * Local file holding the audit-chain master key; never in Postgres. Required in production,
   * where a missing file is an error; elsewhere defaults and is created 0600 if missing.
   */
  KEY_FILE: z.string().min(1).optional(),
  /**
   * Directory anchoring signed audit-chain checkpoints outside Postgres. Must be on storage the
   * database host cannot rewrite (another volume or machine). Required in production.
   */
  CHECKPOINT_DIR: z.string().min(1).optional(),
  /**
   * `true` when exactly one trusted reverse proxy fronts guildd: rate limits then key on the last
   * `X-Forwarded-For` hop instead of the socket address. Anything but true/false fails at boot.
   */
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  ...vapidFields,
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
})

const schema = baseSchema
  .superRefine((env, ctx) => {
    relyingParty(env, ctx)
    vapid(env, ctx)
    if (env.NODE_ENV === 'production' && !env.KEY_FILE) {
      ctx.addIssue({
        code: 'custom',
        path: ['KEY_FILE'],
        message: 'KEY_FILE is required in production',
      })
    }
    if (env.NODE_ENV === 'production' && !env.CHECKPOINT_DIR) {
      ctx.addIssue({
        code: 'custom',
        path: ['CHECKPOINT_DIR'],
        message: 'CHECKPOINT_DIR is required in production',
      })
    }
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
    KEY_FILE: env.KEY_FILE ?? DEV_KEY_FILE,
    CHECKPOINT_DIR: env.CHECKPOINT_DIR ?? DEV_CHECKPOINT_DIR,
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

const vapidSchema = z
  .object({ NODE_ENV: productionFields.NODE_ENV, ...vapidFields })
  .superRefine(vapid)

/** The web push VAPID settings, or undefined when push is not configured (development only). */
export function loadVapidEnv(source: Record<string, string | undefined> = process.env) {
  const env = vapidSchema.parse(source)
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: subject } = env
  return publicKey && privateKey && subject ? { publicKey, privateKey, subject } : undefined
}

const operatorsSchema = z
  .string()
  .default('')
  .transform((raw) =>
    raw
      .split(',')
      .map((id) => id.trim().toLowerCase())
      .filter((id, i, all) => id !== '' && all.indexOf(id) === i)
  )
  .pipe(z.array(z.uuid()))

/**
 * The member ids allowed to bar or lift every guild at once (`PLATFORM_OPERATORS`, comma-separated
 * uuids; unset or empty means nobody). Throws at boot on anything that is not a uuid.
 */
export function loadPlatformOperators(
  source: Record<string, string | undefined> = process.env
): string[] {
  return operatorsSchema.parse(source.PLATFORM_OPERATORS)
}

/** How sandboxes run: nowhere real (tests, development) or in hardened Docker containers. */
export type SandboxEnv =
  | { kind: 'memory' }
  | {
      kind: 'docker'
      image: string
      network: string
      scope: string
      /** Where a sandbox finds the egress proxy. */
      proxyUrl: string
      /** The one origin (model gateway and MCP gateway) a sandbox reaches through the proxy. */
      gatewayUrl: string
    }

/** Reads the sandbox settings (`SANDBOX_RUNNER` and friends); throws at boot on a bad combination. */
export function loadSandboxEnv(
  source: Record<string, string | undefined> = process.env
): SandboxEnv {
  const common = z.object({ NODE_ENV: z.string().default('development') }).parse(source)
  const runner = z.enum(['memory', 'docker']).optional().parse(source.SANDBOX_RUNNER)
  if (common.NODE_ENV === 'production' && runner !== 'docker') {
    throw new Error('SANDBOX_RUNNER must be docker in production')
  }
  if (runner !== 'docker') {
    return { kind: 'memory' }
  }
  const docker = z
    .object({
      SANDBOX_IMAGE: z
        .string()
        .regex(/@sha256:[0-9a-f]{64}$/, 'SANDBOX_IMAGE must be pinned by digest'),
      SANDBOX_NETWORK: z.string().min(1),
      SANDBOX_SCOPE: z.string().min(1).default('default'),
      EGRESS_PROXY_URL: z.url(),
      SANDBOX_GATEWAY_URL: z.url(),
    })
    .parse(source)
  return {
    kind: 'docker',
    image: docker.SANDBOX_IMAGE,
    network: docker.SANDBOX_NETWORK,
    scope: docker.SANDBOX_SCOPE,
    proxyUrl: docker.EGRESS_PROXY_URL,
    gatewayUrl: docker.SANDBOX_GATEWAY_URL,
  }
}
