import { expect, test } from 'bun:test'
import postgres from 'postgres'
import { z } from 'zod'
import { testDbUrl } from '../testing/test-db'
import { createDb } from './client'

test('a Db built with an application name shows it on its sessions, so tests can tell pools apart', async () => {
  const owner = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
  const db = createDb(testDbUrl('app'), { max: 1, applicationName: 'client-name-test' })
  try {
    expect(await db.bumpRateLimit('client-name-test', new Date())).toBeGreaterThan(0)
    const rows = await owner`
      select count(*)::int as n from pg_stat_activity
      where datname = current_database() and application_name = 'client-name-test'`
    expect(z.object({ n: z.number() }).parse(rows[0]).n).toBeGreaterThan(0)
  } finally {
    await db.close()
    await owner.end()
  }
})
