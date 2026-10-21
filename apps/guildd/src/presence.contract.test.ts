import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { expectGuildIsolation } from './testing/cross-guild'
import { createHarness } from './testing/harness'
import { openSession } from './testing/open-session'

const harness = await createHarness({
  devGuildHeader: false,
  now: new Date('2026-01-01T00:00:00.000Z'),
})
afterAll(() => harness.close())

const json = { 'content-type': 'application/json' }
const stateBody = z.object({
  away: z.boolean(),
  since: z.string().nullable(),
  until: z.string().nullable(),
})

async function found(name: string) {
  const guild = await harness.foundGuild({ name, goal: 'g' })
  return { guild, token: await openSession(harness.adapters.identity, guild) }
}

const base = (guild: string) => `/guilds/${guild}/guild-master`
const auth = (token: string | null) => (token ? { authorization: `Bearer ${token}` } : {})
const read = (guild: string, token: string | null) =>
  harness.request(`${base(guild)}/presence`, { headers: auth(token) })
const goAway = (guild: string, token: string | null, body: unknown = {}) =>
  harness.request(`${base(guild)}/away`, {
    method: 'POST',
    headers: { ...json, ...auth(token) },
    body: JSON.stringify(body),
  })
const comeBack = (guild: string, token: string | null) =>
  harness.request(`${base(guild)}/return`, { method: 'POST', headers: auth(token) })

describe('away mode routes', () => {
  test('going away and returning, with no Seal', async () => {
    const { guild, token } = await found('Away')
    expect(stateBody.parse(await (await read(guild, token)).json()).away).toBe(false)
    const res = await goAway(guild, token)
    expect(res.status).toBe(200)
    expect(stateBody.parse(await res.json()).away).toBe(true)
    expect(stateBody.parse(await (await read(guild, token)).json()).away).toBe(true)
    const back = await comeBack(guild, token)
    expect(back.status).toBe(200)
    expect(stateBody.parse(await back.json())).toEqual({ away: false, since: null, until: null })
  })

  test('an expired return time reads as present', async () => {
    const { guild, token } = await found('Expiry')
    const { clock } = harness.adapters
    const until = new Date(clock.now().getTime() + 60_000).toISOString()
    expect((await goAway(guild, token, { until })).status).toBe(200)
    expect(stateBody.parse(await (await read(guild, token)).json()).away).toBe(true)
    clock.advance(61_000)
    expect(stateBody.parse(await (await read(guild, token)).json()).away).toBe(false)
  })

  test('a return time that is not a future instant is refused and changes nothing', async () => {
    const { guild, token } = await found('Bad until')
    const now = harness.adapters.clock.now().toISOString()
    for (const until of ['tomorrow', 5, now, '2020-01-01T00:00:00.000Z']) {
      expect((await goAway(guild, token, { until })).status).toBe(400)
    }
    expect((await goAway(guild, token, 'nonsense')).status).toBe(400)
    expect((await harness.adapters.presence.get(guild)).away).toBe(false)
  })

  test('a return time more than 30 days ahead is refused; just inside is accepted; open-ended stays allowed', async () => {
    const { guild, token } = await found('Cap')
    const day = 86_400_000
    const at = (ms: number) => new Date(harness.adapters.clock.now().getTime() + ms).toISOString()
    expect((await goAway(guild, token, { until: at(30 * day + 1000) })).status).toBe(400)
    expect((await harness.adapters.presence.get(guild)).away).toBe(false)
    expect((await goAway(guild, token, { until: at(30 * day - 1000) })).status).toBe(200)
    expect((await goAway(guild, token, {})).status).toBe(200)
  })

  test('all routes need a session', async () => {
    const { guild } = await found('Anon')
    for (const token of [null, 'forged']) {
      expect((await read(guild, token)).status).toBe(401)
      expect((await goAway(guild, token)).status).toBe(401)
      expect((await comeBack(guild, token)).status).toBe(401)
    }
  })

  test('another guild cannot read or set a guild away state', async () => {
    const caller = await found('Caller')
    const headers = auth(caller.token)
    const snapshot = (guild: string) => harness.adapters.presence.get(guild)
    await expectGuildIsolation(harness, {
      build: (_c, target) => [`${base(target)}/presence`, { headers }],
      snapshot,
    })
    await expectGuildIsolation(harness, {
      build: (_c, target) => [
        `${base(target)}/away`,
        { method: 'POST', headers: { ...json, ...headers }, body: '{}' },
      ],
      snapshot,
    })
    await expectGuildIsolation(harness, {
      build: (_c, target) => [`${base(target)}/return`, { method: 'POST', headers }],
      snapshot,
    })
  })
})
