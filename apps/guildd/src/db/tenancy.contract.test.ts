import { afterAll, describe, expect, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
import postgres from 'postgres'
import { z } from 'zod'
import { expectGuildIsolation } from '../testing/cross-guild'
import { createHarness } from '../testing/harness'
import { InvalidGuildIdError } from './client'

const harness = await createHarness()
afterAll(() => harness.close())
const { db } = harness.adapters

const getGuild = (id: string) => async (): Promise<Response> =>
  harness.request(`/guilds/${id}`, { headers: { 'x-guild-id': id } })

describe('cross-guild isolation', () => {
  test('GET /guilds/:id as guild A cannot see guild B and cannot tell it exists', async () => {
    await expectGuildIsolation(harness, {
      build: (caller, target) => [`/guilds/${target}`, { headers: { 'x-guild-id': caller } }],
      snapshot: async (id) => (await getGuild(id)()).json(),
    })
  })

  test('A cannot update B rows', async () => {
    const a = await db.foundGuild({ name: 'A', goal: 'g' })
    const b = await db.foundGuild({ name: 'B', goal: 'g' })
    const updated = await db.withGuild(
      a,
      (tx) => tx`update guilds set name = 'pwned' where guild_id = ${b} returning guild_id`
    )
    expect(updated.length).toBe(0)
    const [row] = await db.withGuild(b, (tx) => tx`select name from guilds`)
    expect(row?.name).toBe('B')
  })

  test('A inserting a row for B fails identically whether or not B exists (no unique/FK leak)', async () => {
    const a = await db.foundGuild({ name: 'A', goal: 'g' })
    const b = await db.foundGuild({ name: 'B', goal: 'g' })
    const attempt = (target: string) =>
      db
        .withGuild(
          a,
          (tx) => tx`insert into guilds (guild_id, name, goal) values (${target}, 'x', 'y')`
        )
        .then(
          () => 'inserted',
          (e: Error) => e.message
        )
    const existing = await attempt(b)
    const missing = await attempt(crypto.randomUUID())
    expect(existing).toContain('row-level security')
    expect(existing).toBe(missing)
  })
})

describe('hardening', () => {
  test('found_guild inside a tenant transaction restores that guild context', async () => {
    const a = await db.foundGuild({ name: 'A', goal: 'g' })
    const seen = await db.withGuild(a, async (tx) => {
      await tx`select found_guild('Other', 'g')`
      return tx`select guild_id from guilds`
    })
    expect(seen.map((r) => r.guild_id)).toEqual([a])
  })

  test('withGuild rejects a non-uuid guild id before querying', async () => {
    let ran = false
    const attempt = db.withGuild('not-a-uuid', async () => {
      ran = true
    })
    await expect(attempt).rejects.toBeInstanceOf(InvalidGuildIdError)
    expect(ran).toBe(false)
  })

  test('the app role has statement and idle-in-transaction timeouts', async () => {
    const [row] = await harness.owner`
      select rolconfig from pg_roles where rolname = 'guildhall_app'`
    const config = z.array(z.string()).parse(row?.rolconfig ?? [])
    expect(config.some((c) => c.startsWith('statement_timeout='))).toBe(true)
    expect(config.some((c) => c.startsWith('idle_in_transaction_session_timeout='))).toBe(true)
  })

  test('no migration stores a credential', async () => {
    const dir = new URL('../../migrations/', import.meta.url)
    for (const name of await readdir(dir)) {
      expect(await Bun.file(new URL(name, dir)).text()).not.toMatch(/password\s+'/i)
    }
  })
})

describe('tenant context', () => {
  test('is transaction-local: a reused pooled connection sees nothing of the previous guild', async () => {
    const a = await db.foundGuild({ name: 'A', goal: 'g' })
    const one = postgres(harness.appUrl, { max: 1 })
    try {
      await one.begin(async (tx) => {
        await tx`select set_config('app.guild_id', ${a}, true)`
        expect((await tx`select guild_id from guilds`).length).toBe(1)
      })
      const [setting] = await one`select current_setting('app.guild_id', true) as v`
      expect(setting?.v ?? '').toBe('')
      expect((await one`select guild_id from guilds`).length).toBe(0)
    } finally {
      await one.end()
    }
  })

  test('the app role is not the table owner and cannot bypass RLS', async () => {
    const [role] = await harness.owner`
      select r.rolsuper, r.rolbypassrls,
        exists (select 1 from pg_class c where c.relname = 'guilds' and c.relowner = r.oid) as owns
      from pg_roles r where r.rolname = 'guildhall_app'`
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false, owns: false })
  })
})
