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

const tokens = new Map<string, string>()
const headers = (g: string) => ({ authorization: `Bearer ${tokens.get(g) ?? 'none'}` })

const pageBody = z.object({
  sessions: z.array(
    z.object({
      id: z.string(),
      questId: z.string(),
      proposalHash: z.string(),
      status: z.string(),
      reason: z.string().nullable(),
      sealId: z.string().nullable(),
      costMicros: z.number().nullable(),
      votes: z.array(
        z.object({ voice: z.string(), vote: z.string(), reasons: z.array(z.string()) })
      ),
    })
  ),
  next: z.string().nullable(),
})

async function found(): Promise<string> {
  const g = await harness.foundGuild({ name: 'Council', goal: 'g' })
  await harness.adapters.config.seed(g)
  tokens.set(g, await openSession(harness.adapters.identity, g))
  return g
}

async function convene(g: string, hash: string, questId = 'q1'): Promise<string> {
  const opened = await harness.adapters.councilStore.open(g, {
    questId,
    proposalHash: hash.repeat(64),
    day: '2026-01-01',
    sessionCap: 50,
  })
  if (opened.status === 'cap_reached') {
    throw new Error('unexpected cap')
  }
  const cast = (voice: 'architect' | 'skeptic', vote: 'approve' | 'block', costMicros: number) =>
    harness.adapters.councilStore.recordVote(g, opened.session.id, {
      voice,
      vote,
      reasons: [`${voice} reason`],
      abstainCode: null,
      inputTokens: 1,
      outputTokens: 1,
      costMicros,
    })
  await cast('architect', 'approve', 40)
  await cast('skeptic', 'block', 2)
  return opened.session.id
}

describe('GET /guilds/:id/council/sessions', () => {
  test('lists sessions newest first with votes and the summed cost, paginated', async () => {
    const g = await found()
    const first = await convene(g, 'a')
    const second = await convene(g, 'b')
    const res = await harness.request(`/guilds/${g}/council/sessions?limit=1`, {
      headers: headers(g),
    })
    expect(res.status).toBe(200)
    const page = pageBody.parse(await res.json())
    expect(page.sessions.map((s) => s.id)).toEqual([second])
    expect(page.sessions[0]?.costMicros).toBe(42)
    expect(page.sessions[0]?.votes.map((v) => v.voice)).toEqual(['architect', 'skeptic'])
    expect(page.next).toBe(second)
    const older = pageBody.parse(
      await (
        await harness.request(`/guilds/${g}/council/sessions?limit=1&after=${page.next}`, {
          headers: headers(g),
        })
      ).json()
    )
    expect(older.sessions.map((s) => s.id)).toEqual([first])
    expect(older.next).toBeNull()
  })

  test('an escalated session carries its Quest Seal id', async () => {
    const g = await found()
    const questId = crypto.randomUUID()
    const id = await convene(g, 'c', questId)
    await harness.adapters.councilStore.escalate(g, id, 'block')
    const seal = await harness.adapters.sealStore.request(g, {
      questId,
      requestedBy: 'heralds-member-1',
      kind: 'post',
      text: 'hello',
      evidence: 'Council: blocked',
    })
    const res = await harness.request(`/guilds/${g}/council/sessions`, { headers: headers(g) })
    const page = pageBody.parse(await res.json())
    expect(page.sessions[0]).toMatchObject({ status: 'escalated', sealId: seal.id })
  })

  test('rejects a bad page and needs a Guild Master session', async () => {
    const g = await found()
    const bad = await harness.request(`/guilds/${g}/council/sessions?limit=0`, {
      headers: headers(g),
    })
    expect(bad.status).toBe(400)
    const s = await strict.foundGuild({ name: 'Council', goal: 'g' })
    const res = await strict.request(`/guilds/${s}/council/sessions`, {
      headers: { 'x-guild-id': s },
    })
    expect(res.status).toBe(401)
  })

  test('cross-guild probe: another guild looks like a missing one', async () => {
    const caller = await found()
    const mine = await found()
    await convene(mine, 'd')
    await expectGuildIsolation(harness, {
      build: (_c, target) => [`/guilds/${target}/council/sessions`, { headers: headers(caller) }],
      snapshot: (g) => harness.adapters.councilStore.list(g, { limit: 100 }),
    })
  })
})
