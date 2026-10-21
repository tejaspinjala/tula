import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import postgres from 'postgres'
import { migrate, migrationsDir } from '../db/migrate'
import {
  createIsolatedTestDb,
  ensureTestDatabase,
  isolatedDbName,
  testDbName,
  testDbUrl,
  withScratchSchema,
} from './test-db'

/** Counts only the database this worktree owns; others come and go with concurrent workers. */
const dbCount = async () => {
  const admin = postgres(process.env.DATABASE_URL ?? testDbUrl(), { max: 1 })
  try {
    const [row] =
      await admin`select count(*)::int as n from pg_database where datname = ${testDbName()}`
    return row?.n
  } finally {
    await admin.end()
  }
}

test('the central test database is named from DATABASE_URL and ensuring it again creates nothing', async () => {
  expect(testDbName()).toMatch(/_test(_[0-9a-f]{8})?$/)
  const before = await dbCount()
  // Other worktrees create and drop their own databases at the same time; simulate one.
  const other = await createIsolatedTestDb(`count-churn-${crypto.randomUUID()}`)
  try {
    await ensureTestDatabase()
    await ensureTestDatabase()
    expect(await dbCount()).toBe(before)
  } finally {
    await other.drop()
  }
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
  const root = new URL('../../../../', import.meta.url).pathname
  const [ciPath] = await Array.fromAsync(new Bun.Glob('.github/*/ci.yml').scan({ cwd: root }))
  expect(ciPath).toBeDefined()
  const ci = await readFile(`${root}${ciPath ?? ''}`, 'utf8')
  const a = image.exec(compose)?.[1]
  const b = image.exec(ci)?.[1]
  expect(a).toBeDefined()
  expect(b).toBe(a)
})

test('different repo roots get different database names and the same root is stable', () => {
  const base = 'postgres://u:p@localhost:5432/guildhall'
  const a = isolatedDbName(base, '/work/tula.worktrees/a', {})
  const b = isolatedDbName(base, '/work/tula.worktrees/b', {})
  expect(a).not.toBe(b)
  expect(a).toBe(isolatedDbName(base, '/work/tula.worktrees/a', {}))
  expect(a).toMatch(/^guildhall_test_[0-9a-f]{8}$/)
})

test('CI and TEST_DB_ISOLATE=false use the base test database unchanged', () => {
  const base = 'postgres://u:p@localhost:5432/guildhall'
  expect(isolatedDbName(base, '/x', { CI: 'true' })).toBe('guildhall_test')
  expect(isolatedDbName(base, '/x', { TEST_DB_ISOLATE: 'false' })).toBe('guildhall_test')
})

test('a missing database is created and migrated, then ensuring again is a no-op', async () => {
  const name = `guildhall_test_scratch_${crypto.randomUUID().slice(0, 8)}`
  const admin = postgres(process.env.DATABASE_URL ?? testDbUrl(), { max: 1 })
  try {
    expect((await admin`select 1 from pg_database where datname = ${name}`).length).toBe(0)
    await ensureTestDatabase(name)
    await ensureTestDatabase(name)
    expect((await admin`select 1 from pg_database where datname = ${name}`).length).toBe(1)
    const owner = postgres(testDbUrl('owner', name), { max: 1 })
    try {
      const [row] = await owner`select to_regclass('schema_migrations') as t`
      expect(row?.t).not.toBeNull()
    } finally {
      await owner.end()
    }
  } finally {
    await admin.unsafe(`drop database if exists "${name}" with (force)`)
    await admin.end()
  }
})

test('concurrent isolated database setups, drops and scratch migrations do not collide on cluster-wide DDL', async () => {
  const setup = async (n: number) => {
    for (let round = 0; round < 3; round++) {
      const db = await createIsolatedTestDb(`concurrent-${n}-${round}-${crypto.randomUUID()}`)
      await db.drop()
    }
  }
  const scratch = async () => {
    for (let round = 0; round < 3; round++) {
      await withScratchSchema((sql, schema) => migrate(sql, migrationsDir, { schema }))
    }
  }
  await Promise.all([
    ...Array.from({ length: 6 }, (_, n) => setup(n)),
    ...Array.from({ length: 6 }, () => scratch()),
  ])
}, 180_000)
