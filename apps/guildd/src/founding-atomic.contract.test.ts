import { afterAll, expect, test } from 'bun:test'
import { z } from 'zod'
import { MemoryClock } from './adapters/memory-clock'
import { MemoryRateLimiter } from './adapters/memory-rate-limiter'
import { createHarness, UNLIMITED_RATE_LIMITS } from './testing/harness'
import { SoftwareAuthenticator } from './testing/software-authenticator'

const ORIGIN = 'http://localhost:5173'
const harness = await createHarness()
afterAll(() => harness.close())

const ceremony = z.object({
  challengeId: z.string(),
  options: z.object({ challenge: z.string() }),
})

function post(path: string, body: unknown) {
  return harness.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function guildCount(name: string): Promise<number> {
  const [row] = await harness.owner`select count(*)::int as n from guilds where name = ${name}`
  return Number(row?.n)
}

test('an abandoned founding ceremony writes no guild', async () => {
  const before = await harness.owner`select count(*)::int as n from guilds`
  const begun = await post('/founding/begin', {})
  expect(begun.status).toBe(200)
  ceremony.parse(await begun.json())
  const after = await harness.owner`select count(*)::int as n from guilds`
  expect(after[0]?.n).toBe(before[0]?.n)
})

test('founding writes the guild and its first passkey only once registration verifies', async () => {
  const name = `Ember ${crypto.randomUUID()}`
  const key = await SoftwareAuthenticator.create('localhost', ORIGIN)
  const begun = ceremony.parse(await (await post('/founding/begin', {})).json())
  expect(await guildCount(name)).toBe(0)
  const finished = await post('/founding/finish', {
    challengeId: begun.challengeId,
    response: await key.register(begun.options),
    name,
    goal: 'Ship a newsletter',
  })
  expect(finished.status).toBe(201)
  const { id } = z.object({ id: z.string() }).parse(await finished.json())
  expect(await guildCount(name)).toBe(1)
  const [creds] =
    await harness.owner`select count(*)::int as n from identity_credentials where guild_id = ${id}`
  expect(Number(creds?.n)).toBe(1)
})

test('a failure while writing the credential rolls the guild back', async () => {
  const name = `Rollback ${crypto.randomUUID()}`
  const key = await SoftwareAuthenticator.create('localhost', ORIGIN)
  const first = ceremony.parse(await (await post('/founding/begin', {})).json())
  const ok = await post('/founding/finish', {
    challengeId: first.challengeId,
    response: await key.register(first.options),
    name: `First ${crypto.randomUUID()}`,
    goal: 'g',
  })
  expect(ok.status).toBe(201)
  // The same credential id again is refused; the second guild must not remain.
  const second = ceremony.parse(await (await post('/founding/begin', {})).json())
  const again = await post('/founding/finish', {
    challengeId: second.challengeId,
    response: await key.register(second.options),
    name,
    goal: 'g',
  })
  expect(again.status).toBeGreaterThanOrEqual(400)
  expect(await guildCount(name)).toBe(0)
})

test('the legacy POST /guilds is gone, even with the dev guild header on', async () => {
  const res = await harness.request('/guilds', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Legacy', goal: 'g' }),
  })
  expect(res.status).toBe(404)
})

test('one founding costs one hit on the founding bucket, not one per request', async () => {
  const one = { limit: 1, windowMs: 60_000 }
  const h = await createHarness({
    app: {
      rateLimiter: new MemoryRateLimiter(new MemoryClock(new Date('2026-01-01T00:00:00.000Z'))),
      rateLimits: { ...UNLIMITED_RATE_LIMITS, founding: { client: one, unknown: one } },
    },
  })
  try {
    const send = (path: string, body: unknown) =>
      h.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const key = await SoftwareAuthenticator.create('localhost', ORIGIN)
    const begun = ceremony.parse(await (await send('/founding/begin', {})).json())
    const finished = await send('/founding/finish', {
      challengeId: begun.challengeId,
      response: await key.register(begun.options),
      name: `Ratey ${crypto.randomUUID()}`,
      goal: 'g',
    })
    expect(finished.status).toBe(201)
  } finally {
    await h.close()
  }
})
