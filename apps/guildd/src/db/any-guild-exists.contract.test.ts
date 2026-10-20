import { afterAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { createHarness } from '../testing/harness'

const harness = await createHarness({ isolatedDb: true })
afterAll(() => harness.close())

describe('any_guild_exists (migration 0056)', () => {
  test('answers a bare boolean to the app role, across tenants, and turns true once a guild exists', async () => {
    const app = postgres(harness.appUrl, { max: 1, onnotice: () => {} })
    try {
      const before = await app`select any_guild_exists() as exists`
      expect(before).toHaveLength(1)
      expect(before[0]).toEqual({ exists: false })
      await harness.foundGuild({ name: 'First', goal: 'g' })
      const after = await app`select any_guild_exists() as exists`
      expect(after[0]).toEqual({ exists: true })
    } finally {
      await app.end()
    }
  })

  test('is a security definer with a pinned search path, not executable by public', async () => {
    const [row] = await harness.owner`select prosecdef, proconfig::text as config,
      has_function_privilege('public', oid, 'execute') as public_exec
      from pg_proc where proname = 'any_guild_exists'`
    expect(row?.prosecdef).toBe(true)
    expect(row?.config).toContain('search_path=pg_catalog, pg_temp')
    expect(row?.public_exec).toBe(false)
  })
})
