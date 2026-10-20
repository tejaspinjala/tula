import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { migrate } from '../src/db/migrate'

const adminUrl =
  process.env.DATABASE_URL ?? 'postgres://guildhall:guildhall@localhost:5432/guildhall'
const dbName = `migrate_test_${Date.now()}`
const admin = postgres(adminUrl, { max: 1 })
let sql: postgres.Sql

beforeAll(async () => {
  await admin.unsafe(`create database ${dbName}`)
  const url = new URL(adminUrl)
  url.pathname = `/${dbName}`
  sql = postgres(url.toString(), { max: 1 })
})

afterAll(async () => {
  await sql.end()
  await admin.unsafe(`drop database ${dbName}`)
  await admin.end()
})

describe('migrate', () => {
  test('applies migrations to a fresh database, then is a no-op on re-run', async () => {
    const first = await migrate(sql)
    expect(first.applied).toEqual(['0001_baseline.sql'])

    const second = await migrate(sql)
    expect(second.applied).toEqual([])

    const rows = await sql`select name from schema_migrations order by name`
    expect(rows.map((r) => r.name)).toEqual(['0001_baseline.sql'])
  })
})
