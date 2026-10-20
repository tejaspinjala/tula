import { afterAll, describe, expect, test } from 'bun:test'
import { hashBytes } from './ports/object-store'
import { expectGuildIsolation } from './testing/cross-guild'
import { createHarness } from './testing/harness'

const harness = await createHarness()
afterAll(() => harness.close())

const enc = (text: string) => new TextEncoder().encode(text)

async function found(name: string): Promise<string> {
  return harness.adapters.db.foundGuild({ name, goal: `${name} goal` })
}

function store(guild: string, text: string, cls = 'report', method = 'PUT') {
  return harness.request(`/artifacts?class=${cls}`, {
    method,
    headers: { 'x-guild-id': guild },
    body: enc(text),
  })
}

describe('artifacts', () => {
  test('storing returns the hash; fetching by hash returns the bytes and class', async () => {
    const guild = await found('Ember')
    const res = await store(guild, 'quarterly notes')
    expect(res.status).toBe(201)
    const hash = hashBytes(enc('quarterly notes'))
    expect(await res.json()).toEqual({ hash, size: 15, class: 'report' })

    const got = await harness.request(`/artifacts/${hash}`, { headers: { 'x-guild-id': guild } })
    expect(got.status).toBe(200)
    expect(got.headers.get('x-artifact-class')).toBe('report')
    expect(await got.text()).toBe('quarterly notes')
  })

  test('storing the same bytes twice is idempotent: one row, one object', async () => {
    const guild = await found('Twice')
    const before = harness.adapters.objectStore.size
    await store(guild, 'same')
    const again = await store(guild, 'same', 'report', 'POST')
    expect(again.status).toBe(201)
    expect(harness.adapters.objectStore.size).toBe(before + 1)
    const rows = await harness.owner`select 1 from artifacts where guild_id = ${guild}`
    expect(rows.length).toBe(1)
  })

  test('an unknown or malformed hash is a clean 404', async () => {
    const guild = await found('Missing')
    for (const hash of ['0'.repeat(64), 'nope']) {
      const res = await harness.request(`/artifacts/${hash}`, { headers: { 'x-guild-id': guild } })
      expect(res.status).toBe(404)
    }
  })

  test('requires a caller and a valid class', async () => {
    const guild = await found('Strict')
    const anon = await harness.request('/artifacts?class=report', { method: 'PUT', body: 'x' })
    expect(anon.status).toBe(401)
    expect((await store(guild, 'x', 'Bad Class')).status).toBe(400)
  })

  test('GET /artifacts/:hash is isolated between guilds', async () => {
    const secret = 'B-secret bytes'
    await expectGuildIsolation(harness, {
      build: (caller) => [
        `/artifacts/${hashBytes(enc(secret))}`,
        { headers: { 'x-guild-id': caller } },
      ],
      // Seeds the target guild's own artifact (idempotent) so there is something to steal.
      snapshot: async (guildId) => {
        await store(guildId, secret)
        return harness.owner`select hash, size, class from artifacts where guild_id = ${guildId}`
      },
    })
  })

  test('storing the same bytes as another guild neither reveals nor alters its artifact', async () => {
    const secret = 'B-secret twin'
    await expectGuildIsolation(harness, {
      build: (caller) => [
        '/artifacts?class=other',
        { method: 'PUT', headers: { 'x-guild-id': caller }, body: enc(secret) },
      ],
      snapshot: async (guildId) => {
        await store(guildId, secret)
        return harness.owner`select hash, size, class from artifacts where guild_id = ${guildId}`
      },
    })
  })
})
