import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defaultConfig } from './guild-config'
import { expectGuildIsolation } from './testing/cross-guild'
import { createHarness } from './testing/harness'
import { openSession } from './testing/open-session'

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

const pageWithLinks = pageBody.extend({
  links: z.array(z.object({ parentId: z.string(), childId: z.string(), depth: z.number() })),
})
const quest = (jobKey: string) => ({
  jobKey,
  templateId: 'herald-brief',
  hallId: 'heralds',
  rank: 'journeyman' as const,
  dataClass: 'internal' as const,
  title: 'Brief',
  ownerId: 'heralds-member-2',
  doneCondition: 'A draft brief is filed',
  roundLimit: 2,
})
const get = (g: string, query: string) =>
  harness.request(`${base(g)}${query}`, { headers: headers(g) })

const base = (g: string) => `/guilds/${g}/quests`
const headers = (g: string) => ({ 'content-type': 'application/json', 'x-guild-id': g })

/** Writes need a real session; the dev header only reads. */
const tokens = new Map<string, string>()
const bearer = (g: string) => ({
  'content-type': 'application/json',
  authorization: `Bearer ${tokens.get(g) ?? 'none'}`,
})

function post(g: string, body: unknown) {
  return harness.request(base(g), {
    method: 'POST',
    headers: bearer(g),
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
  tokens.set(g, await openSession(harness.adapters.identity, g))
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

  test('a private template is 422 hall_locked in a locked Hall, 422 hall_not_private_eligible in an unlocked one, and queues once the Hall is eligible', async () => {
    const g = await found('P')
    const health = { templateId: 'health-log', jobKey: 'h1', title: 'Log' }
    const locked = await post(g, health)
    expect(locked.status).toBe(422)
    expect(await locked.json()).toEqual({ error: 'hall_locked' })
    const seed = defaultConfig()
    const open = (privateEligible: boolean) =>
      seed.halls.map((h) =>
        h.id === 'health'
          ? {
              ...h,
              locked: false,
              privateEligible,
              members: [{ id: 'health-member-1', name: 'Healer', rank: 'journeyman' as const }],
            }
          : h
      )
    const config = harness.adapters.config
    const first = await config.propose(g, { ...seed, halls: open(false) })
    if (first.status === 'pending') {
      await config.confirm(g, first.version)
    }
    const unfit = await post(g, health)
    expect(unfit.status).toBe(422)
    expect(await unfit.json()).toEqual({ error: 'hall_not_private_eligible' })
    const second = await config.propose(g, { ...seed, halls: open(true) })
    if (second.status === 'pending') {
      await config.confirm(g, second.version)
    }
    const posted = await post(g, health)
    expect(posted.status).toBe(201)
    const queued = questBody.parse(await posted.json())
    expect(queued).toMatchObject({ hallId: 'health', ownerId: 'health-member-1' })
    expect((await harness.adapters.quests.get(g, queued.id))?.dataClass).toBe('private')
    // Another guild never sees the private Quest.
    const other = await found('P2')
    expect((await page(other, '')).quests).toEqual([])
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

  test('the list carries the Sub-Quest links of its page, so the Quest Board can nest children', async () => {
    const g = await found('Q')
    const queue = harness.adapters.quests
    const parent = (await queue.post(g, quest('p'))).quest
    const claimed = await queue.claim(g, { leaseMs: 60_000, maxActive: 5 })
    const made = await queue.spawn(g, {
      parentId: parent.id,
      attempt: claimed?.attempts ?? 0,
      briefHash: 'a'.repeat(64),
      child: quest('c'),
      maxChildren: 3,
      maxDepth: 2,
    })
    const body = pageWithLinks.parse(await (await get(g, '')).json())
    expect(body.links).toEqual([
      { parentId: parent.id, childId: made.ok ? made.quest.id : '', depth: 1 },
    ])
    expect((await get(g, '?state=done')).status).toBe(200)
    expect(pageWithLinks.parse(await (await get(g, '?state=done')).json()).links).toEqual([])
  })

  test('without a session or dev header the routes are 401', async () => {
    const g = await strict.foundGuild({ name: 'Q', goal: 'g' })
    expect((await strict.request(base(g), { headers: { 'x-guild-id': g } })).status).toBe(401)
  })

  test('posting needs a real session: the dev header alone is 401', async () => {
    const g = await found('Q')
    const res = await harness.request(base(g), {
      method: 'POST',
      headers: headers(g),
      body: JSON.stringify(brief('x')),
    })
    expect(res.status).toBe(401)
    const ticket = await harness.request(`/guilds/${g}/events/ticket`, {
      method: 'POST',
      headers: headers(g),
    })
    expect(ticket.status).toBe(401)
  })

  test('cross-guild: a session cannot post into another guild, same as a missing one', async () => {
    const a = await found('A')
    const b = await found('B')
    const ghost = crypto.randomUUID()
    tokens.set(b, tokens.get(a) ?? '')
    tokens.set(ghost, tokens.get(a) ?? '')
    expect((await post(b, brief('x'))).status).toBe(404)
    expect((await post(ghost, brief('x'))).status).toBe(404)
    expect((await harness.adapters.quests.list(b, { limit: 100 })).quests).toEqual([])
  })

  test('cross-guild: a guild cannot post to or read another guild`s Quests', async () => {
    const snapshot = async (g: string) =>
      (await harness.adapters.quests.list(g, { limit: 100 })).quests.map((q) => q.id)
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
