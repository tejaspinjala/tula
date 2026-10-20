import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { MemoryModelProvider } from './adapters/memory-model-provider'
import { defaultConfig, guildConfig } from './guild-config'
import { runIdFor } from './model-gateway'
import { expectGuildIsolation } from './testing/cross-guild'
import { createHarness } from './testing/harness'
import { openSession } from './testing/open-session'

const provider = new MemoryModelProvider()
const harness = await createHarness({ devGuildHeader: true, app: { modelProvider: provider } })
afterAll(async () => {
  await harness.close()
})

const KEY = 'sk-http-test-key'
const body = { messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 }
const errorBody = z.object({ error: z.string() })
const usagePage = z.object({
  rows: z.array(z.object({ key: z.string(), calls: z.number(), costMicros: z.number() })),
  next: z.string().nullable(),
})

/** A founded guild with an api_key provider, a priced profile, a vault key and a session. */
async function found(name: string, caps = defaultConfig().caps) {
  const g = await harness.foundGuild({ name, goal: 'g' })
  const { config } = harness.adapters
  await config.seed(g)
  const next = guildConfig.parse({
    ...defaultConfig(),
    caps,
    providers: [{ id: 'cloud', auth: 'api_key' }],
    routingProfiles: [
      {
        id: 'cloud-mid',
        provider: 'cloud',
        tier: 'mid',
        model: 'configured-model',
        price: { inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 },
      },
    ],
  })
  const proposed = await config.propose(g, next)
  if (proposed.status === 'pending') {
    await config.confirm(g, proposed.version)
  }
  await harness.adapters.secrets.add(g, 'cloud', KEY)
  const session = await openSession(harness.adapters.identity, g)
  return { g, session }
}

const leased = new Map<string, { id: string; attempts: number }>()

/** Posts and claims a Quest for the run called `name` in guild `g` (attempt 1). */
async function leaseFor(g: string, name: string) {
  const key = `${g}:${name}`
  const known = leased.get(key)
  if (known) {
    return known
  }
  const { quests } = harness.adapters
  const { quest } = await quests.post(g, {
    jobKey: key,
    templateId: 'herald-brief',
    hallId: 'heralds',
    rank: 'journeyman',
    dataClass: 'internal',
    title: name,
    ownerId: 'heralds-member-2',
    doneCondition: 'done',
    roundLimit: 2,
  })
  const claimed = await quests.claim(g, {
    leaseMs: 24 * 3_600_000,
    maxActive: 1000,
    questId: quest.id,
  })
  if (!claimed) {
    throw new Error('expected a lease')
  }
  leased.set(key, claimed)
  return claimed
}

async function start(g: string, name: string) {
  const quest = await leaseFor(g, name)
  const out = await harness.adapters.gateway.openRun(g, {
    questId: quest.id,
    attempt: quest.attempts,
    hallId: 'heralds',
    profileId: 'cloud-mid',
  })
  if (out.status !== 'started') {
    throw new Error(`expected started, got ${out.status}`)
  }
  return out.token
}

const call = (token: string) =>
  harness.request('/gateway/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })

describe('gateway routes', () => {
  test('a run calls with its token and gets text and usage, never the key', async () => {
    const { g } = await found('G1')
    provider.script({ ok: true, text: 'hello', usage: { inputTokens: 4, outputTokens: 2 } })
    const res = await call(await start(g, 'r1'))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ text: 'hello', usage: { inputTokens: 4, outputTokens: 2 } })
    expect(text).not.toContain(KEY)
  })

  test('no token, a forged token and a revoked token are 401', async () => {
    const { g } = await found('G2')
    const token = await start(g, 'r1')
    expect((await harness.request('/gateway/complete', { method: 'POST' })).status).toBe(401)
    expect((await call('ghr.nope')).status).toBe(401)
    await harness.adapters.gateway.revokeRun(g, runIdFor((await leaseFor(g, 'r1')).id, 1))
    const res = await call(token)
    expect(res.status).toBe(401)
    expect(errorBody.parse(await res.json()).error).toBe('token_revoked')
  })

  test('a call into a paused Hall is 409 hall_paused', async () => {
    const { g } = await found('G2b')
    const token = await start(g, 'r1')
    await harness.adapters.tripwires.pause(g, {
      hallId: 'heralds',
      tripwire: 'manual',
      observed: 0,
      threshold: 0,
    })
    const res = await call(token)
    expect(res.status).toBe(409)
    expect(errorBody.parse(await res.json()).error).toBe('hall_paused')
  })

  test('a call past the daily cap is 429 cap_reached', async () => {
    const { g } = await found('G3', { dailyTokens: 200, dailySpendCents: 1000 })
    provider.script({ ok: true, text: 'x', usage: { inputTokens: 150, outputTokens: 100 } })
    const token = await start(g, 'r1')
    expect((await call(token)).status).toBe(200)
    const res = await call(token)
    expect(res.status).toBe(429)
    expect(errorBody.parse(await res.json()).error).toBe('cap_reached')
  })

  test('parallel calls against a cap that admits one: one reaches the provider, the rest are 429', async () => {
    const { g } = await found('G3b', { dailyTokens: 150, dailySpendCents: 1000 })
    provider.script({ ok: true, text: 'x', usage: { inputTokens: 100, outputTokens: 60 } })
    const token = await start(g, 'r1')
    const seenBefore = provider.seen.length
    const statuses = (await Promise.all(Array.from({ length: 5 }, () => call(token)))).map(
      (r) => r.status
    )
    expect(statuses.filter((s) => s === 200)).toHaveLength(1)
    expect(statuses.filter((s) => s === 429)).toHaveLength(4)
    expect(provider.seen.length - seenBefore).toBe(1)
  })

  test('a reused client key is refused before any provider call; a bad body is 400', async () => {
    const { g } = await found('G3c')
    provider.script({ ok: true, text: 'x', usage: { inputTokens: 1, outputTokens: 1 } })
    const token = await start(g, 'r1')
    const send = (b: unknown) =>
      harness.request('/gateway/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(b),
      })
    expect((await send({ ...body, idempotencyKey: 'k' })).status).toBe(200)
    const seen = provider.seen.length
    expect((await send({ ...body, idempotencyKey: 'k' })).status).toBe(409)
    expect(provider.seen.length).toBe(seen)
    expect((await send({ ...body, messages: [] })).status).toBe(400)
  })

  test('the cost table pages spend by Quest, Hall, run and day', async () => {
    const { g, session } = await found('G4')
    provider.script({ ok: true, text: 'x', usage: { inputTokens: 200_000, outputTokens: 100_000 } })
    expect((await call(await start(g, 'r1'))).status).toBe(200)
    const get = (query: string, auth: Record<string, string>) =>
      harness.request(`/guilds/${g}/gateway/usage${query}`, { headers: auth })
    const ok = await get('?by=quest&limit=5', { authorization: `Bearer ${session}` })
    expect(ok.status).toBe(200)
    expect(usagePage.parse(await ok.json()).rows).toEqual([
      expect.objectContaining({
        key: (await leaseFor(g, 'r1')).id,
        calls: 1,
        costMicros: 2_100_000,
      }),
    ])
    expect((await get('?by=nope', { authorization: `Bearer ${session}` })).status).toBe(400)
    expect((await get('?by=day', {})).status).toBe(401)
    const auth = { authorization: `Bearer ${session}` }
    expect((await get('?by=day&after=garbage', auth)).status).toBe(400)
    expect((await get('?by=day&after=2026-02-30', auth)).status).toBe(400)
    expect((await get('?by=day&after=2026-01-01', auth)).status).toBe(200)
  })

  test("another guild cannot read a guild's cost table", async () => {
    await expectGuildIsolation(harness, {
      build: (caller, target) => [
        `/guilds/${target}/gateway/usage?by=run`,
        { headers: { 'x-guild-id': caller } },
      ],
      snapshot: (guild) => harness.adapters.gateway.usage(guild, 'run', { limit: 100 }),
    })
  })
})
