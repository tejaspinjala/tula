import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defaultConfig } from './guild-config'
import { expectGuildIsolation } from './testing/cross-guild'
import { createHarness } from './testing/harness'

const harness = await createHarness({ devGuildHeader: true })
const strict = await createHarness({ devGuildHeader: false })
afterAll(async () => {
  await harness.close()
  await strict.close()
})

const questBody = z.object({
  id: z.string(),
  state: z.string(),
  hallId: z.string(),
  ownerId: z.string(),
})
const pageBody = z.object({ quests: z.array(questBody), next: z.string().nullable() })

const base = (g: string) => `/guilds/${g}/quests`
const headers = (g: string) => ({ 'content-type': 'application/json', 'x-guild-id': g })

function post(g: string, body: unknown) {
  return harness.request(base(g), {
    method: 'POST',
    headers: headers(g),
    body: JSON.stringify(body),
  })
}

async function page(g: string, query: string, path = base(g)) {
  const res = await harness.request(`${path}${query}`, { headers: headers(g) })
  return pageBody.parse(await res.json())
}

async function found(name: string) {
  const g = await harness.foundGuild({ name, goal: 'g' })
  await harness.adapters.config.seed(g)
  return g
}

const brief = (jobKey: string) => ({ templateId: 'herald-brief', jobKey, title: 'Brief' })

describe('quest routes', () => {
  test('posting from a template queues a Quest; a repeated job key is 200 with the same Quest', async () => {
    const g = await found('Q')
    const first = await post(g, brief('k1'))
    expect(first.status).toBe(201)
    const quest = questBody.parse(await first.json())
    expect(quest).toMatchObject({ state: 'queued', hallId: 'heralds' })
    const again = await post(g, brief('k1'))
    expect(again.status).toBe(200)
    expect(questBody.parse(await again.json()).id).toBe(quest.id)
    const events = await harness.owner`
      select type from events where guild_id = ${g} and type like 'quest.%'`
    expect(events.map((e) => e.type)).toEqual(['quest.posted'])
  })

  test('a locked Hall is 422 hall_locked; an unknown template is 422; bad input is 400', async () => {
    const g = await found('Q')
    const seed = defaultConfig()
    const halls = seed.halls.map((h) => (h.id === 'heralds' ? { ...h, locked: true } : h))
    await harness.adapters.config.propose(g, { ...seed, halls })
    const locked = await post(g, brief('k1'))
    expect(locked.status).toBe(422)
    expect(await locked.json()).toEqual({ error: 'hall_locked' })
    const g2 = await found('Q2')
    expect((await post(g2, { ...brief('k'), templateId: 'nope' })).status).toBe(422)
    expect((await post(g2, { jobKey: '' })).status).toBe(400)
  })

  test('lists are paginated and filter by state; dead letters are listed apart', async () => {
    const g = await found('Q')
    for (const k of ['a', 'b', 'c']) {
      await post(g, brief(k))
    }
    const p1 = await page(g, '?limit=2')
    expect(p1.quests).toHaveLength(2)
    const p2 = await page(g, `?limit=2&after=${p1.next}`)
    expect(p2.quests).toHaveLength(1)
    expect(p2.next).toBeNull()
    expect((await page(g, '?state=done')).quests).toEqual([])
    expect((await harness.request(`${base(g)}?limit=0`, { headers: headers(g) })).status).toBe(400)
    expect((await page(g, '', `${base(g)}/dead-letters`)).quests).toEqual([])
  })

  test('without a session or dev header the routes are 401', async () => {
    const g = await strict.foundGuild({ name: 'Q', goal: 'g' })
    expect((await strict.request(base(g), { headers: { 'x-guild-id': g } })).status).toBe(401)
  })

  test('cross-guild: a guild cannot post to or read another guild`s Quests', async () => {
    const snapshot = async (g: string) =>
      (await harness.adapters.quests.list(g, { limit: 100 })).quests.map((q) => q.id)
    await expectGuildIsolation(harness, {
      build: (caller, target) => [
        base(target),
        { method: 'POST', headers: headers(caller), body: JSON.stringify(brief('x')) },
      ],
      snapshot,
    })
    await expectGuildIsolation(harness, {
      build: (caller, target) => [base(target), { headers: headers(caller) }],
      snapshot,
    })
    await expectGuildIsolation(harness, {
      build: (caller, target) => [`${base(target)}/dead-letters`, { headers: headers(caller) }],
      snapshot,
    })
  })
})
