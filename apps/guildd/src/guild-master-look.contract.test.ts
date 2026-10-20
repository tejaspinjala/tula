import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { expectGuildIsolation } from './testing/cross-guild'
import { createHarness } from './testing/harness'
import { openSession } from './testing/open-session'

const harness = await createHarness({ devGuildHeader: false })
afterAll(() => harness.close())

const json = { 'content-type': 'application/json' }
const lookBody = z.object({
  look: z
    .object({
      body: z.number(),
      outfitStyle: z.number(),
      outfitColor: z.number(),
      hairStyle: z.number(),
      hairColor: z.number(),
    })
    .nullable(),
})
const look = { body: 2, outfitStyle: 4, outfitColor: 1, hairStyle: 0, hairColor: 7 }

async function found(name: string) {
  const guild = await harness.foundGuild({ name, goal: 'g' })
  return { guild, token: await openSession(harness.adapters.identity, guild) }
}

const path = (guild: string) => `/guilds/${guild}/guild-master/look`

function read(guild: string, token: string | null) {
  return harness.request(path(guild), {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

function save(guild: string, token: string | null, body: unknown) {
  return harness.request(path(guild), {
    method: 'PUT',
    headers: { ...json, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
}

describe('Guild Master look routes', () => {
  test('a new guild has no look; a saved look is read back by another session of the guild', async () => {
    const { guild, token } = await found('Looks')
    expect(lookBody.parse(await (await read(guild, token)).json()).look).toBeNull()
    const put = await save(guild, token, { look })
    expect(put.status).toBe(200)
    expect(lookBody.parse(await put.json()).look).toEqual(look)
    // Another device signs in as the same Guild Master and sees the same character.
    const other = await openSession(harness.adapters.identity, guild)
    expect(lookBody.parse(await (await read(guild, other)).json()).look).toEqual(look)
  })

  test('a look outside the fixed catalogue is refused and changes nothing', async () => {
    const { guild, token } = await found('Catalogue')
    await save(guild, token, { look })
    for (const bad of [
      { ...look, outfitStyle: 10 },
      { ...look, body: -1 },
      { ...look, hairColor: 1.5 },
      { ...look, cape: 1 },
      { body: 0 },
    ]) {
      expect((await save(guild, token, { look: bad })).status).toBe(400)
    }
    expect((await save(guild, token, 'nonsense')).status).toBe(400)
    expect(await harness.adapters.guildMasterLooks.get(guild)).toEqual(look)
  })

  test('both routes need a session', async () => {
    const { guild } = await found('Anon')
    expect((await read(guild, null)).status).toBe(401)
    expect((await save(guild, null, { look })).status).toBe(401)
    expect((await read(guild, 'forged')).status).toBe(401)
  })

  test('another guild cannot read or change a guild look', async () => {
    const caller = await found('Caller')
    const auth = { authorization: `Bearer ${caller.token}` }
    const snapshot = (guild: string) => harness.adapters.guildMasterLooks.get(guild)
    await expectGuildIsolation(harness, {
      build: (_caller, target) => [path(target), { headers: auth }],
      snapshot,
    })
    await expectGuildIsolation(harness, {
      build: (_caller, target) => [
        path(target),
        { method: 'PUT', headers: { ...json, ...auth }, body: JSON.stringify({ look }) },
      ],
      snapshot,
    })
  })
})
