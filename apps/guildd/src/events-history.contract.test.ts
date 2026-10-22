import { afterAll, expect, test } from 'bun:test'
import { z } from 'zod'
import { foundViaApi } from './testing/found-via-api'
import { createHarness } from './testing/harness'

const harness = await createHarness({ devGuildHeader: false })
afterAll(() => harness.close())

const json = { 'content-type': 'application/json' }
const ceremony = z.object({ challengeId: z.string(), options: z.object({ challenge: z.string() }) })
const _founded = z.object({ id: z.string(), foundingToken: z.string() })
const session = z.object({ token: z.string(), guildId: z.string() })
const page = z.object({
  events: z.array(z.object({ seq: z.number(), type: z.string(), occurredAt: z.string() })),
  next: z.number().nullable(),
})

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return harness.request(path, {
    method: 'POST',
    headers: { ...json, ...headers },
    body: JSON.stringify(body),
  })
}

async function signedIn() {
  const guild = await foundViaApi(harness, { name: 'Replay', goal: 'g' })
  const key = guild.key
  const sign = ceremony.parse(await (await post(`/guilds/${guild.id}/sign-in/begin`, {})).json())
  const res = await post(`/guilds/${guild.id}/sign-in/finish`, {
    challengeId: sign.challengeId,
    response: await key.assert(sign.options),
  })
  return session.parse(await res.json())
}

const get = (path: string, token?: string) =>
  harness.request(path, token ? { headers: { authorization: `Bearer ${token}` } } : {})

test('history is session-guarded and scoped to the caller guild', async () => {
  const a = await signedIn()
  const b = await signedIn()
  expect((await get(`/guilds/${a.guildId}/events/history`)).status).toBe(401)
  expect((await get(`/guilds/${b.guildId}/events/history`, a.token)).status).toBe(404)
})

test('history pages the log in seq order and stops at an until seq', async () => {
  const s = await signedIn()
  const all = page.parse(await (await get(`/guilds/${s.guildId}/events/history`, s.token)).json())
  expect(all.events.length).toBeGreaterThan(2)
  expect(all.events.map((e) => e.seq)).toEqual(all.events.map((_, i) => i + 1))

  const first = page.parse(
    await (await get(`/guilds/${s.guildId}/events/history?limit=2`, s.token)).json()
  )
  expect(first.events.map((e) => e.seq)).toEqual([1, 2])
  expect(first.next).toBe(2)
  const second = page.parse(
    await (await get(`/guilds/${s.guildId}/events/history?limit=2&after=2`, s.token)).json()
  )
  expect(second.events[0]?.seq).toBe(3)

  const upTo = page.parse(
    await (await get(`/guilds/${s.guildId}/events/history?until=2`, s.token)).json()
  )
  expect(upTo.events.map((e) => e.seq)).toEqual([1, 2])
  expect(upTo.next).toBeNull()
})

test('history stops at an until time and rejects a bad bound', async () => {
  const s = await signedIn()
  const before = page.parse(
    await (
      await get(`/guilds/${s.guildId}/events/history?until=2000-01-01T00:00:00.000Z`, s.token)
    ).json()
  )
  expect(before.events).toEqual([])
  const after = page.parse(
    await (
      await get(`/guilds/${s.guildId}/events/history?until=2999-01-01T00:00:00.000Z`, s.token)
    ).json()
  )
  expect(after.events.length).toBeGreaterThan(2)
  expect((await get(`/guilds/${s.guildId}/events/history?until=banana`, s.token)).status).toBe(400)
})
