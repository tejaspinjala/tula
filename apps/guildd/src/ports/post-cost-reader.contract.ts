import { describe, expect, test } from 'bun:test'
import type { ModelLedger } from './model-ledger'
import type { PostCostReader } from './post-cost-reader'
import type { QuestQueue } from './quest-queue'
import type { SealStore } from './seal-store'

/** A reader under test, the stores it reads, and a way to get real guilds. */
export interface PostCostReaderFixture {
  reader: PostCostReader
  quests: QuestQueue
  ledger: ModelLedger
  seals: SealStore
  newGuild: () => Promise<string>
}

/** A Quest of `campaignId` that spent `costMicros` and whose Seal ended as `seal` (or was never asked). */
export async function meterQuest(
  f: Pick<PostCostReaderFixture, 'quests' | 'ledger' | 'seals'>,
  guild: string,
  key: string,
  campaignId: string | undefined,
  costMicros: number,
  seal: 'posted' | 'denied' | null
): Promise<string> {
  const { quest } = await f.quests.post(guild, {
    jobKey: key,
    ...(campaignId ? { campaignId } : {}),
    templateId: 'herald-announcement',
    hallId: 'heralds',
    rank: 'apprentice',
    dataClass: 'public',
    title: key,
    ownerId: 'heralds-member-1',
    doneCondition: 'A draft is ready for a Seal',
    roundLimit: 2,
  })
  if (costMicros > 0) {
    const runId = `run-${key}`
    await f.ledger.openRun(guild, {
      runId,
      questId: quest.id,
      attempt: 1,
      hallId: 'heralds',
      providerId: 'cloud',
      profileId: 'cloud-mid',
      state: 'active',
      tokenHash: `hash-${runId}`,
      expiresAt: null,
    })
    const entry = {
      callKey: `call-${key}`,
      runId,
      day: '2030-01-01',
      inputTokens: 10,
      outputTokens: 5,
      costMicros,
    }
    await f.ledger.reserve(guild, {
      ...entry,
      clientKey: null,
      caps: { tokens: 1_000_000, costMicros: 1_000_000_000 },
    })
    await f.ledger.settle(guild, entry.callKey, entry)
  }
  if (seal !== null) {
    const s = await f.seals.request(guild, {
      questId: quest.id,
      requestedBy: 'heralds-member-1',
      kind: 'post',
      text: key,
      evidence: 'verdict: pass',
    })
    await f.seals.decide(guild, s.id, {
      verdict: seal === 'posted' ? 'approved' : 'denied',
      expectedHash: s.actionHash,
    })
    if (seal === 'posted') {
      const held = await f.seals.reserve(guild, s.id, key)
      if (held.ok) {
        await f.seals.consume(guild, s.id, { text: key, token: held.token })
      }
    }
  }
  return quest.id
}

/** The PostCostReader contract, run against every adapter. `make` returns fresh stores. */
export function postCostReaderContract(name: string, make: () => Promise<PostCostReaderFixture>) {
  describe(`PostCostReader contract: ${name}`, () => {
    test('counts only Quests whose Seal was posted, per Campaign and overall', async () => {
      const f = await make()
      const g = await f.newGuild()
      await meterQuest(f, g, 'a', 'spring', 3000, 'posted')
      await meterQuest(f, g, 'b', 'spring', 1000, 'posted')
      await meterQuest(f, g, 'c', 'spring', 5000, 'denied')
      await meterQuest(f, g, 'd', undefined, 600, 'posted')
      await meterQuest(f, g, 'e', 'summer', 9000, null)
      const report = await f.reader.byCampaign(g, { limit: 10 })
      expect(report.overall).toEqual({ posts: 3, costMicros: 4600, costPerPostMicros: 1533 })
      expect(report.campaigns).toEqual([
        { campaignId: null, posts: 1, costMicros: 600, costPerPostMicros: 600 },
        { campaignId: 'spring', posts: 2, costMicros: 4000, costPerPostMicros: 2000 },
      ])
      expect(report.next).toBeNull()
    })

    test('a posted Quest with no metered spend still counts as a post', async () => {
      const f = await make()
      const g = await f.newGuild()
      await meterQuest(f, g, 'a', 'spring', 3000, 'posted')
      await meterQuest(f, g, 'b', 'spring', 0, 'posted')
      const report = await f.reader.byCampaign(g, { limit: 10 })
      expect(report.overall).toEqual({ posts: 2, costMicros: 3000, costPerPostMicros: 1500 })
      expect(report.campaigns).toEqual([
        { campaignId: 'spring', posts: 2, costMicros: 3000, costPerPostMicros: 1500 },
      ])
    })

    test('pages through Campaigns with a cursor; overall covers every page', async () => {
      const f = await make()
      const g = await f.newGuild()
      await meterQuest(f, g, 'a', 'spring', 3000, 'posted')
      await meterQuest(f, g, 'd', undefined, 600, 'posted')
      await meterQuest(f, g, 'e', 'summer', 100, 'posted')
      const first = await f.reader.byCampaign(g, { limit: 1 })
      expect(first.campaigns.map((c) => c.campaignId)).toEqual([null])
      expect(first.overall.posts).toBe(3)
      expect(first.next).not.toBeNull()
      const second = await f.reader.byCampaign(g, {
        limit: 1,
        ...(first.next === null ? {} : { after: first.next }),
      })
      expect(second.campaigns.map((c) => c.campaignId)).toEqual(['spring'])
      const third = await f.reader.byCampaign(g, {
        limit: 1,
        ...(second.next === null ? {} : { after: second.next }),
      })
      expect(third.campaigns.map((c) => c.campaignId)).toEqual(['summer'])
      expect(third.next).toBeNull()
      expect(third.overall).toEqual(first.overall)
    })

    test("another guild's posts are not counted", async () => {
      const f = await make()
      const g = await f.newGuild()
      const other = await f.newGuild()
      await meterQuest(f, other, 'x', 'spring', 700, 'posted')
      expect(await f.reader.byCampaign(g, { limit: 10 })).toEqual({
        overall: { posts: 0, costMicros: 0, costPerPostMicros: 0 },
        campaigns: [],
        next: null,
      })
    })
  })
}
