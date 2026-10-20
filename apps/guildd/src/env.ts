import { z } from 'zod'

const schema = z.object({
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
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
})

/** Validated process environment for guildd. */
export type Env = z.infer<typeof schema>

/** Parses the environment, throwing at boot on anything invalid. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return schema.parse(source)
}
