import postgres from 'postgres'
import { z } from 'zod'
import { migrate, provisionAppRole } from './migrate'

/** Only what migration needs: the owner connection and the app role's password. */
const migrateEnv = z.object({
  DATABASE_URL: z.url(),
  APP_DB_PASSWORD: z.string().min(1),
})

const parsed = migrateEnv.safeParse(process.env)
if (!parsed.success) {
  const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ')
  process.stderr.write(`db:migrate needs DATABASE_URL and APP_DB_PASSWORD (invalid: ${missing})\n`)
  process.exit(1)
}

const sql = postgres(parsed.data.DATABASE_URL, { max: 1, onnotice: () => {} })
try {
  const { applied } = await migrate(sql)
  await provisionAppRole(sql, parsed.data.APP_DB_PASSWORD)
  process.stdout.write(`${applied.length ? `applied: ${applied.join(', ')}` : 'up to date'}\n`)
} finally {
  await sql.end()
}
