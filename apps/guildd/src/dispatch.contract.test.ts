import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defaultConfig, guildConfig, type TripwireThresholds } from './guild-config'
import { createHarness } from './testing/harness'
import { openSession } from './testing/open-session'

const harness = await createHarness()
afterAll(async () => {
  await harness.close()
})

const outcome = z.object({
  status: z.string(),
  questId: z.string().optional(),
  profileId: z.string().optional(),
})

/** A founded guild with one api-key provider, a session and one queued Quest. */
async function found(tripwires?: TripwireThresholds) {
  const g = await harness.foundGuild({ name: 'Dispatch', goal: 'g' })
  await harness.adapters.config.seed(g)
  const next = guildConfig.parse({
    ...defaultConfig(),
    ...(tripwires ? { tripwires } : {}),
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

  test('a burst of Seal denials pauses the Hall and the next dispatch claims nothing for it', async () => {
    const { g, auth } = await found({
      tokenBurnMultiple: 3,
      gateDenialsPerHour: 2,
      loopRepeats: 5,
    })
    const { quests, sealStore } = harness.adapters
    const newQuest = (jobKey: string) => ({
      jobKey,
      templateId: 'herald-brief',
      hallId: 'heralds',
      rank: 'journeyman' as const,
      dataClass: 'internal' as const,
      title: jobKey,
      ownerId: 'heralds-member-2',
      doneCondition: 'A draft brief is filed',
      roundLimit: 3,
    })
    // `found` queued one Quest; two more are claimed, held for a Seal, and denied.
    for (const jobKey of ['denied-1', 'denied-2']) {
      const { quest } = await quests.post(g, newQuest(jobKey))
      const claimed = await quests.claim(g, { leaseMs: 60_000, maxActive: 5, questId: quest.id })
      await quests.submitForSeal(g, quest.id, claimed?.attempts ?? 0)
      const seal = await sealStore.request(g, {
        questId: quest.id,
        requestedBy: 'heralds-member-2',
        kind: 'post',
        text: jobKey,
        evidence: 'verdict: pass',
        round: 1,
      })
      await sealStore.decide(g, seal.id, { verdict: 'denied', expectedHash: seal.actionHash })
    }
    const res = await dispatch(g, auth)
    expect(res.status).toBe(200)
    expect(outcome.parse(await res.json()).status).toBe('idle')
    expect(await harness.adapters.tripwires.isPaused(g, 'heralds')).toBe(true)
    expect(await harness.adapters.sandboxes.list(g)).toEqual([])
    expect(outcome.parse(await (await dispatch(g, auth)).json()).status).toBe('idle')
  })
})
