import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { expectGuildIsolation } from './testing/cross-guild'
import { createHarness } from './testing/harness'
import { openSession } from './testing/open-session'

const harness = await createHarness({ devGuildHeader: true })
const strict = await createHarness({ devGuildHeader: false })
afterAll(async () => {
  await harness.close()
  await strict.close()
})

const row = z.object({
  id: z.string(),
  fromHall: z.string(),
  toHall: z.string(),
  question: z.string(),
  status: z.string(),
  answer: z.string().nullable(),
})
const pageBody = z.object({ inquiries: z.array(row), next: z.number().nullable() })

const tokens = new Map<string, string>()
const headers = (g: string) => ({ authorization: `Bearer ${tokens.get(g) ?? 'none'}` })
const listPath = (g: string, hall = 'heralds') => `/guilds/${g}/halls/${hall}/inquiries`

async function found(): Promise<string> {
  const g = await harness.foundGuild({ name: 'Inquiries', goal: 'g' })
  await harness.adapters.config.seed(g)
  tokens.set(g, await openSession(harness.adapters.identity, g))
  return g
}

/** Files an Inquiry from `from` to `to` straight through the store. */
async function ask(g: string, from: string, to: string, question: string): Promise<string> {
  const id = crypto.randomUUID()
  const out = await harness.adapters.inquiries.ask(g, {
    id,
    fromHall: from,
    toHall: to,
    askQuestId: crypto.randomUUID(),
    attempt: 1,
    asker: 'heralds-member-2',
    question,
    maxPerQuest: 5,
    at: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
    answerQuest: {
      jobKey: `inquiry:${id}`,
      templateId: 'inquiry-answer',
      hallId: to,
      rank: 'journeyman',
      dataClass: 'internal',
      title: 'Answer an Inquiry',
      ownerId: 'heralds-captain',
      doneCondition: `Answer Inquiry ${id}`,
      roundLimit: 2,
    },
  })
  if (!out.ok) {
    throw new Error('ask refused')
  }
  return out.inquiry.id
}

describe('Hall inquiries routes', () => {
  test('the Guild Master lists a Hall’s Inquiries, in and out, newest first, in pages', async () => {
    const g = await found()
    await ask(g, 'heralds', 'health', 'out-1')
    await ask(g, 'health', 'heralds', 'in-1')
    await ask(g, 'heralds', 'health', 'out-2')
    await ask(g, 'health', 'personal', 'elsewhere')
    const first = pageBody.parse(
      await (await harness.request(`${listPath(g)}?limit=2`, { headers: headers(g) })).json()
    )
    expect(first.inquiries.map((i) => i.question)).toEqual(['out-2', 'in-1'])
    expect(first.next).not.toBeNull()
    const second = pageBody.parse(
      await (
        await harness.request(`${listPath(g)}?limit=2&after=${first.next}`, {
          headers: headers(g),
        })
      ).json()
    )
    expect(second.inquiries.map((i) => i.question)).toEqual(['out-1'])
    expect(second.next).toBeNull()
  })

  test('one Inquiry reads back with its status; an unknown or foreign id is a 404', async () => {
    const g = await found()
    const id = await ask(g, 'heralds', 'health', 'one question')
    const res = await harness.request(`/guilds/${g}/inquiries/${id}`, { headers: headers(g) })
    expect(res.status).toBe(200)
    expect(row.parse(await res.json())).toMatchObject({
      id,
      fromHall: 'heralds',
      toHall: 'health',
      question: 'one question',
      status: 'open',
      answer: null,
    })
    for (const bad of [crypto.randomUUID(), 'not-a-uuid']) {
      const missing = await harness.request(`/guilds/${g}/inquiries/${bad}`, {
        headers: headers(g),
      })
      expect(missing.status).toBe(404)
    }
  })

  test('a bad page, or a Hall the guild does not have, is refused', async () => {
    const g = await found()
    const get = (path: string) => harness.request(path, { headers: headers(g) })
    expect((await get(`${listPath(g)}?limit=0`)).status).toBe(400)
    expect((await get(`${listPath(g)}?limit=101`)).status).toBe(400)
    expect((await get(`${listPath(g)}?after=abc`)).status).toBe(400)
    expect((await get(listPath(g, 'no-such-hall'))).status).toBe(404)
  })

  test('without a session the routes answer 401', async () => {
    const g = await strict.foundGuild({ name: 'Inquiries', goal: 'g' })
    await strict.adapters.config.seed(g)
    const auth = { headers: { 'x-guild-id': g } }
    expect((await strict.request(listPath(g), auth)).status).toBe(401)
    expect(
      (await strict.request(`/guilds/${g}/inquiries/${crypto.randomUUID()}`, auth)).status
    ).toBe(401)
  })

  test('cross-guild probe: another guild looks like a missing one', async () => {
    const caller = await found()
    const victim = await found()
    const id = await ask(victim, 'heralds', 'health', 'secret question')
    await expectGuildIsolation(harness, {
      build: (_caller, target) => [listPath(target), { headers: headers(caller) }],
      snapshot: (g) => harness.adapters.inquiries.list(g, { hallId: 'heralds', limit: 100 }),
    })
    await expectGuildIsolation(harness, {
      build: (_caller, target) => [
        `/guilds/${target}/inquiries/${id}`,
        { headers: headers(caller) },
      ],
      snapshot: (g) => harness.adapters.inquiries.get(g, id),
    })
  })
})
