import { z } from 'zod'

const schema = z.object({
  /** Owner connection: used only by migrations and test setup. */
  DATABASE_URL: z.url().default('postgres://guildhall:guildhall@localhost:5432/guildhall'),
  /** Non-owner `guildhall_app` connection: the only one the running app uses. */
  APP_DATABASE_URL: z.url(),
  /** Trust `x-guild-id` as the caller's guild. Development only, until authentication lands. */
  DEV_GUILD_HEADER: z
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
