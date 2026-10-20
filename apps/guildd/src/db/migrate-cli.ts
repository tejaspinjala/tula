import postgres from 'postgres'
import { loadEnv } from '../env'
import { migrate } from './migrate'

const sql = postgres(loadEnv().DATABASE_URL, { max: 1, onnotice: () => {} })
try {
  const { applied } = await migrate(sql)
  process.stdout.write(`${applied.length ? `applied: ${applied.join(', ')}` : 'up to date'}\n`)
} finally {
  await sql.end()
}
