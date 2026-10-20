import { afterAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { createHarness } from '../testing/harness'

const harness = await createHarness({ isolatedDb: true })
afterAll(() => harness.close())

async function addCredential(guildId: string, credentialId: string) {
  await harness.owner`insert into identity_credentials (guild_id, credential_id, public_key)
    values (${guildId}, ${credentialId}, 'pk')`
}

describe('guild_for_credential (migration 0057)', () => {
  test('answers only a guild uuid (or null) to the app role, across tenants', async () => {
    const a = await harness.foundGuild({ name: 'A', goal: 'g' })
    const b = await harness.foundGuild({ name: 'B', goal: 'g' })
    await addCredential(a, 'cred-a')
    await addCredential(b, 'cred-b')
    const app = postgres(harness.appUrl, { max: 1, onnotice: () => {} })
    try {
      const [forA] = await app`select guild_for_credential('cred-a') as guild_id`
      const [forB] = await app`select guild_for_credential('cred-b') as guild_id`
      const [unknown] = await app`select guild_for_credential('nope') as guild_id`
      expect(forA).toEqual({ guild_id: a })
      expect(forB).toEqual({ guild_id: b })
      expect(unknown).toEqual({ guild_id: null })
    } finally {
      await app.end()
    }
  })

  test('is a security definer with a pinned search path, executable by the app role only', async () => {
    const [row] = await harness.owner`select prosecdef, proconfig::text as config,
      pg_get_function_result(oid) as result,
      has_function_privilege('public', oid, 'execute') as public_exec,
      has_function_privilege('guildhall_app', oid, 'execute') as app_exec
      from pg_proc where proname = 'guild_for_credential'`
    expect(row?.prosecdef).toBe(true)
    expect(row?.config).toContain('search_path=pg_catalog, pg_temp')
    expect(row?.result).toBe('uuid')
    expect(row?.public_exec).toBe(false)
    expect(row?.app_exec).toBe(true)
  })

  test('credential ids are unique across guilds, by an index that leads with credential_id', async () => {
    const [row] = await harness.owner`select indexdef from pg_indexes
      where tablename = 'identity_credentials' and indexdef ilike 'create unique index%(credential_id)%'`
    expect(row).toBeDefined()
    const a = await harness.foundGuild({ name: 'C', goal: 'g' })
    const b = await harness.foundGuild({ name: 'D', goal: 'g' })
    await addCredential(a, 'shared-id')
    expect(addCredential(b, 'shared-id')).rejects.toThrow()
  })
})
