import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defaultConfig, guildConfig } from './guild-config'
import { createHarness, UNLIMITED_RATE_LIMITS } from './testing/harness'
import { openSession } from './testing/open-session'

const harness = await createHarness({
  now: new Date(Date.UTC(2040, 0, 1) + Math.floor(Math.random() * 1_000_000) * 60_000),
  app: {
    rateLimits: { ...UNLIMITED_RATE_LIMITS, dispatch: { client: { limit: 3, windowMs: 60_000 } } },
  },
})
afterAll(async () => {
  await harness.close()
})

const outcome = z.object({
  status: z.string(),
  questId: z.string().optional(),
  profileId: z.string().optional(),
})

/** A founded guild with one api-key provider, a session and one queued Quest. */
async function found() {
  const g = await harness.foundGuild({ name: 'Dispatch', goal: 'g' })
  await harness.adapters.config.seed(g)
  const next = guildConfig.parse({
    ...defaultConfig(),
    providers: [{ id: 'cloud', auth: 'api_key' }],
    routingProfiles: [
      { id: 'cloud-mid', provider: 'cloud', tier: 'mid', model: 'configured-model' },
    ],
  })
  const proposed = await harness.adapters.config.propose(g, next)
  if (proposed.status === 'pending') {
    await harness.adapters.config.confirm(g, proposed.version)
  }
  await harness.adapters.secrets.add(g, 'cloud', 'sk-dispatch-test-key')
  const session = await openSession(harness.adapters.identity, g)
  const { quest } = await harness.adapters.quests.post(g, {
    jobKey: 'brief',
    templateId: 'herald-brief',
    hallId: 'heralds',
    rank: 'journeyman',
    dataClass: 'internal',
    title: 'Brief',
    ownerId: 'heralds-member-2',
    doneCondition: 'A draft brief is filed',
    roundLimit: 2,
  })
  return { g, quest, session, auth: { authorization: `Bearer ${session}` } }
}

const dispatch = (g: string, auth: Record<string, string>) =>
  harness.request(`/guilds/${g}/dispatch`, { method: 'POST', headers: auth })

describe('POST /guilds/:id/dispatch', () => {
  test('claims, routes and starts one Quest, then finds the queue idle', async () => {
    const { g, quest, auth } = await found()
    const res = await dispatch(g, auth)
    expect(res.status).toBe(202)
    expect(outcome.parse(await res.json())).toEqual({
      status: 'started',
      questId: quest.id,
      profileId: 'cloud-mid',
    })
    expect(await harness.adapters.sandboxes.list(g)).toHaveLength(1)
    const again = await dispatch(g, auth)
    expect(again.status).toBe(200)
    expect(outcome.parse(await again.json()).status).toBe('idle')
  })

  test('a barred guild is refused with 409', async () => {
    const { g, session, auth } = await found()
    const member = (await harness.adapters.identity.resolveSession(session))?.memberId ?? ''
    await harness.adapters.gates.bar({ guildId: g, memberId: member }, 'guild')
    const res = await dispatch(g, auth)
    expect(res.status).toBe(409)
    expect(outcome.parse(await res.json()).status).toBe('barred')
    expect(await harness.adapters.sandboxes.list(g)).toEqual([])
  })

  test('needs a session', async () => {
    const { g } = await found()
    expect((await dispatch(g, {})).status).toBe(401)
  })

  test('is rate limited per client: the extra call is a 429 with Retry-After', async () => {
    const { g, auth } = await found()
    for (let i = 0; i < 3; i++) {
      expect((await dispatch(g, auth)).status).not.toBe(429)
    }
    const refused = await dispatch(g, auth)
    expect(refused.status).toBe(429)
    expect(refused.headers.get('retry-after')).not.toBeNull()
  })
})
