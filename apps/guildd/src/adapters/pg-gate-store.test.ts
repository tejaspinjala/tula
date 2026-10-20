import { afterAll, expect, test } from 'bun:test'
import postgres from 'postgres'
import { z } from 'zod'
import { createDb } from '../db/client'
import { gateStoreContract } from '../ports/gate-store.contract'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { MemoryKeyProvider } from './memory-key-provider'
import { PgGateStore } from './pg-gate-store'

const db = createDb(testDbUrl('app'))
const owner = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
afterAll(async () => {
  await db.close()
  await owner.end()
})

gateStoreContract('postgres', async () => ({
  store: new PgGateStore(db, new MemoryKeyProvider()),
  newGuild: () => foundTestGuild(db, { name: 'Gates', goal: 'g' }),
  events: async (guildId: string) =>
    (
      await owner`
        select type from events where guild_id = ${guildId} and type like 'gates.%' order by seq`
    ).map((e) => String(e.type)),
  payload: async (guildId: string, type: string) => {
    const [row] = await owner`
      select payload from events where guild_id = ${guildId} and type = ${type}
      order by seq desc limit 1`
    return row ? z.record(z.string(), z.unknown()).parse(row.payload) : null
  },
}))

test('the cross-guild helper functions are schema-qualified, pinned and app-only', async () => {
  const fns = await owner`
    select proname, prosrc, proconfig, prosecdef from pg_proc
    where proname in ('list_guild_ids', 'revoke_all_run_tokens', 'release_all_leases') order by proname`
  expect(fns).toHaveLength(3)
  for (const fn of fns) {
    expect(fn.prosecdef).toBe(true)
    expect(String(fn.proconfig)).toContain('search_path=pg_catalog, pg_temp')
  }
  expect(String(fns[0]?.prosrc)).toContain('public.guilds')
  expect(String(fns[1]?.prosrc)).toContain('public.quests')
  expect(String(fns[2]?.prosrc)).toContain('public.model_runs')
  const [grants] = await owner`
    select has_function_privilege('public', 'list_guild_ids(uuid, integer)', 'execute') as pub,
           has_function_privilege('guildhall_app', 'list_guild_ids(uuid, integer)', 'execute') as app,
           has_function_privilege('public', 'revoke_all_run_tokens()', 'execute') as pub2,
           has_function_privilege('guildhall_app', 'revoke_all_run_tokens()', 'execute') as app2,
           has_function_privilege('public', 'release_all_leases(text)', 'execute') as pub3,
           has_function_privilege('guildhall_app', 'release_all_leases(text)', 'execute') as app3`
  expect(grants).toEqual({
    pub: false,
    app: true,
    pub2: false,
    app2: true,
    pub3: false,
    app3: true,
  })
})
