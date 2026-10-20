import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defaultConfig } from './guild-config'
import { expectGuildIsolation } from './testing/cross-guild'
import { createHarness } from './testing/harness'
import { openSession } from './testing/open-session'

const harness = await createHarness({ devGuildHeader: true })
afterAll(async () => {
  await harness.close()
})

const started = z.object({ campaignId: z.string(), questId: z.string() })
const tokens = new Map<string, string>()
const bearer = (g: string) => ({
  'content-type': 'application/json',
  authorization: `Bearer ${tokens.get(g) ?? 'none'}`,
})
const start = (g: string, body: unknown, headers: Record<string, string> = bearer(g)) =>
  harness.request(`/guilds/${g}/campaigns/team`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

async function found(name: string) {
  const g = await harness.foundGuild({ name, goal: 'g' })
  await harness.adapters.config.seed(g)
  tokens.set(g, await openSession(harness.adapters.identity, g))
  return g
}

describe('POST /guilds/:id/campaigns/team', () => {
  test('gives the Hall`s Captain a Campaign goal as their first Quest', async () => {
    const g = await found('Team')
    const res = await start(g, { hall: 'heralds', campaignId: 'launch-1', goal: 'Plan the launch' })
    expect(res.status).toBe(201)
    const body = started.parse(await res.json())
    expect(body.campaignId).toBe('launch-1')
    const quest = await harness.adapters.quests.get(g, body.questId)
    expect(quest).toMatchObject({
      ownerId: 'heralds-captain',
      hallId: 'heralds',
      campaignId: 'launch-1',
      board: false,
      state: 'queued',
    })
    expect(quest?.doneCondition).toContain('Plan the launch')
    const events = await harness.owner`
      select type, payload from events where guild_id = ${g} and type like 'campaign.%'`
    // campaign.started is a team event: it comes with the Captain's first board Quest.
    expect(events).toHaveLength(0)
  })

  test('a repeat of the same Campaign id is 200 with the same Quest', async () => {
    const g = await found('Team')
    const first = started.parse(
      await (await start(g, { hall: 'heralds', campaignId: 'c', goal: 'Goal' })).json()
    )
    const again = await start(g, { hall: 'heralds', campaignId: 'c', goal: 'Goal' })
    expect(again.status).toBe(200)
    expect(started.parse(await again.json()).questId).toBe(first.questId)
  })

  test('an unknown or locked Hall, a Hall with no Captain, and a paused Hall are 422; bad input is 400', async () => {
    const g = await found('Team')
    expect(await (await start(g, { hall: 'nowhere', campaignId: 'c', goal: 'G' })).json()).toEqual({
      error: 'hall_not_found',
    })
    expect(await (await start(g, { hall: 'health', campaignId: 'c', goal: 'G' })).json()).toEqual({
      error: 'hall_locked',
    })
    const seed = defaultConfig()
    const scribes = {
      id: 'scribes',
      name: 'Scribes',
      kind: 'work' as const,
      locked: false,
      privateEligible: false,
      captain: null,
      members: [],
    }
    const proposed = await harness.adapters.config.propose(g, {
      ...seed,
      halls: [...seed.halls, scribes],
    })
    if (proposed.status === 'pending') {
      await harness.adapters.config.confirm(g, proposed.version)
    }
    const res = await start(g, { hall: 'scribes', campaignId: 'c', goal: 'G' })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'no_captain' })
    await harness.adapters.tripwires.pause(g, {
      hallId: 'heralds',
      tripwire: 'manual',
      observed: 0,
      threshold: 0,
    })
    expect(await (await start(g, { hall: 'heralds', campaignId: 'c', goal: 'G' })).json()).toEqual({
      error: 'hall_paused',
    })
    expect((await start(g, { hall: 'heralds', goal: 'G' })).status).toBe(400)
  })

  test('a blocker that is not a Quest of the guild is 422 unknown_blocker and writes no Quest', async () => {
    const g = await found('Team')
    const res = await start(g, {
      hall: 'heralds',
      campaignId: 'blocked',
      goal: 'G',
      blockedBy: [crypto.randomUUID()],
    })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'unknown_blocker' })
    expect((await harness.adapters.quests.list(g, { limit: 100 })).quests).toHaveLength(0)
  })

  test('needs a session', async () => {
    const g = await found('Team')
    const res = await start(
      g,
      { hall: 'heralds', campaignId: 'c', goal: 'G' },
      {
        'content-type': 'application/json',
      }
    )
    expect(res.status).toBe(401)
  })

  test('cross-guild: a guild cannot start a Campaign in another guild', async () => {
    await expectGuildIsolation(harness, {
      build: (caller, target) => [
        `/guilds/${target}/campaigns/team`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-guild-id': caller },
          body: JSON.stringify({ hall: 'heralds', campaignId: 'c', goal: 'G' }),
        },
      ],
      snapshot: async (g) => (await harness.adapters.quests.list(g, { limit: 100 })).quests.length,
    })
  })
})
