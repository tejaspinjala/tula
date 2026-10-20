import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.url().default('postgres://guildhall:guildhall@localhost:5432/guildhall'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
})

/** Validated process environment for guildd. */
export type Env = z.infer<typeof schema>

/** Parses the environment, throwing at boot on anything invalid. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return schema.parse(source)
}
