import postgres from 'postgres'
import { loadEnv } from '../env'
import { migrate, provisionAppRole } from './migrate'

const sql = postgres(loadEnv().DATABASE_URL, { max: 1, onnotice: () => {} })
try {
  const { applied } = await migrate(sql)
  const password = process.env.APP_DB_PASSWORD
  if (password) {
    await provisionAppRole(sql, password)
  }
  process.stdout.write(`${applied.length ? `applied: ${applied.join(', ')}` : 'up to date'}\n`)
} finally {
  await sql.end()
}
