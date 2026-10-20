import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { createHarness } from './testing/harness'
import { openSession } from './testing/open-session'

const harness = await createHarness()
afterAll(async () => {
  await harness.close()
})

const postCost = z.object({
  posts: z.number(),
  costMicros: z.number(),
  costPerPostMicros: z.number(),
})
const report = z.object({
  overall: postCost,
  campaigns: z.array(postCost.extend({ campaignId: z.string().nullable() })),
  next: z.string().nullable(),
})

/** A founded guild with a signed-in session. */
async function found() {
  const g = await harness.foundGuild({ name: 'Costs', goal: 'g' })
  await harness.adapters.config.seed(g)
  const session = await openSession(harness.adapters.identity, g)
  return { g, auth: { authorization: `Bearer ${session}` } }
}

/** A Quest of Campaign `spring` that spent `costMicros`, whose Seal was consumed (or denied). */
async function meterPost(g: string, costMicros: number, outcome: 'posted' | 'denied') {
  const { quests, modelLedger, sealStore } = harness.adapters
  const { quest } = await quests.post(g, {
    jobKey: crypto.randomUUID(),
    campaignId: 'spring',
    templateId: 'herald-announcement',
    hallId: 'heralds',
    rank: 'apprentice',
    dataClass: 'public',
    title: 'Announce',
    ownerId: 'heralds-member-1',
    doneCondition: 'A draft is ready for a Seal',
    roundLimit: 2,
  })
  const runId = crypto.randomUUID()
  await modelLedger.openRun(g, {
    runId,
    questId: quest.id,
    attempt: 1,
    hallId: 'heralds',
    providerId: 'cloud',
    profileId: 'cloud-mid',
    state: 'active',
    tokenHash: null,
    expiresAt: null,
  })
  const entry = {
    callKey: crypto.randomUUID(),
    runId,
    day: '2030-01-01',
    inputTokens: 10,
    outputTokens: 5,
    costMicros,
  }
  await modelLedger.reserve(g, {
    ...entry,
    clientKey: null,
    caps: { tokens: 1_000_000, costMicros: 1_000_000_000 },
  })
  await modelLedger.settle(g, entry.callKey, entry)
  const seal = await sealStore.request(g, {
    questId: quest.id,
    requestedBy: 'heralds-member-1',
    kind: 'post',
    text: 'Hello',
    evidence: 'verdict: pass',
  })
  await sealStore.decide(g, seal.id, {
    verdict: outcome === 'posted' ? 'approved' : 'denied',
    expectedHash: seal.actionHash,
  })
  if (outcome === 'posted') {
    const held = await sealStore.reserve(g, seal.id, 'Hello')
    if (held.ok) {
      await sealStore.consume(g, seal.id, { text: 'Hello', token: held.token })
    }
  }
}

const read = (g: string, auth: Record<string, string>, query = '') =>
  harness.request(`/guilds/${g}/cost-per-post${query}`, { headers: auth })

describe('GET /guilds/:id/cost-per-post', () => {
  test('needs a session', async () => {
    const { g } = await found()
    expect((await read(g, {})).status).toBe(401)
  })

  test('a guild with no accepted post reports zero', async () => {
    const { g, auth } = await found()
    const res = await read(g, auth)
    expect(res.status).toBe(200)
    expect(report.parse(await res.json())).toEqual({
      overall: { posts: 0, costMicros: 0, costPerPostMicros: 0 },
      campaigns: [],
      next: null,
    })
  })

  test('counts the spend of posted Quests only, per Campaign', async () => {
    const { g, auth } = await found()
    await meterPost(g, 700, 'posted')
    await meterPost(g, 300, 'posted')
    await meterPost(g, 9000, 'denied')
    const res = await read(g, auth)
    expect(res.status).toBe(200)
    expect(report.parse(await res.json())).toEqual({
      overall: { posts: 2, costMicros: 1000, costPerPostMicros: 500 },
      campaigns: [{ campaignId: 'spring', posts: 2, costMicros: 1000, costPerPostMicros: 500 }],
      next: null,
    })
  })

  test('a malformed page is refused', async () => {
    const { g, auth } = await found()
    expect((await read(g, auth, '?limit=0')).status).toBe(400)
  })
})
