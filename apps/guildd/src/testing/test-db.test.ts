import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import postgres from 'postgres'
import { ensureTestDatabase, testDbName, testDbUrl } from './test-db'

const dbCount = async () => {
  const admin = postgres(process.env.DATABASE_URL ?? testDbUrl(), { max: 1 })
  try {
    const [row] = await admin`select count(*)::int as n from pg_database`
    return row?.n
  } finally {
    await admin.end()
  }
}

test('the central test database is named from DATABASE_URL and ensuring it again creates nothing', async () => {
  expect(testDbName().endsWith('_test')).toBe(true)
  const before = await dbCount()
  await ensureTestDatabase()
  await ensureTestDatabase()
  expect(await dbCount()).toBe(before)
})

test('no test or harness code issues create database (only the central setup does)', async () => {
  const files = [
    'harness.ts',
    'rls-check.test.ts',
    '../db/migrate-cli.test.ts',
    '../../integration/migrate.integration.ts',
  ]
  for (const file of files) {
    const text = await readFile(new URL(file, import.meta.url), 'utf8')
    expect(text.toLowerCase()).not.toContain('create database')
  }
})

test('compose and CI reference the same Postgres image', async () => {
  const image = /image:\s*(postgres:\S+)/
  const compose = await readFile(new URL('../../../../docker-compose.yml', import.meta.url), 'utf8')
  const ci = await readFile(
    new URL('../../../../.github/workflows/ci.yml', import.meta.url),
    'utf8'
  )
  const a = image.exec(compose)?.[1]
  const b = image.exec(ci)?.[1]
  expect(a).toBeDefined()
  expect(b).toBe(a)
})
