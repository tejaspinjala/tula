import { describe, expect, test } from 'bun:test'
import { MemoryClock } from './adapters/memory-clock'
import { MemoryModelLedger } from './adapters/memory-model-ledger'
import { MemoryQuestQueue } from './adapters/memory-quest-queue'
import { MemorySealStore } from './adapters/memory-seal-store'
import { costPerPost } from './cost-per-post'

async function world() {
  const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))
  const quests = new MemoryQuestQueue(clock, () => 0.5)
  const seals = new MemorySealStore(clock)
  const ledger = new MemoryModelLedger()
  const guild = crypto.randomUUID()
  /** A Quest that spent `costMicros` and whose Seal ended as `seal`. */
  const quest = async (
    jobKey: string,
    campaignId: string | undefined,
    costMicros: number,
    seal: 'posted' | 'denied' | null
  ) => {
    const { quest: q } = await quests.post(guild, {
      jobKey,
      ...(campaignId ? { campaignId } : {}),
      templateId: 'herald-announcement',
      hallId: 'heralds',
      rank: 'apprentice',
      dataClass: 'public',
      title: jobKey,
      ownerId: 'heralds-member-1',
      doneCondition: 'A draft is ready for a Seal',
      roundLimit: 2,
    })
    if (costMicros > 0) {
      await meter(q.id, jobKey, costMicros)
    }
    if (seal !== null) {
      await sealIt(q.id, jobKey, seal)
    }
    return q
  }
  const meter = async (questId: string, jobKey: string, costMicros: number) => {
    await ledger.openRun(guild, {
      runId: `run-${jobKey}`,
      questId,
      attempt: 1,
      hallId: 'heralds',
      providerId: 'cloud',
      profileId: 'cloud-mid',
      state: 'active',
      tokenHash: `hash-${jobKey}`,
      expiresAt: null,
    })
    const entry = {
      callKey: `call-${jobKey}`,
      runId: `run-${jobKey}`,
      day: '2030-01-01',
      inputTokens: 10,
      outputTokens: 5,
      costMicros,
    }
    await ledger.reserve(guild, {
      ...entry,
      clientKey: null,
      caps: { tokens: 1_000_000, costMicros: 1_000_000_000 },
    })
    await ledger.settle(guild, entry.callKey, entry)
  }
  const sealIt = async (questId: string, jobKey: string, seal: 'posted' | 'denied') => {
    {
      const s = await seals.request(guild, {
        questId,
        requestedBy: 'heralds-member-1',
        kind: 'post',
        text: jobKey,
        evidence: 'verdict: pass',
      })
      await seals.decide(guild, s.id, {
        verdict: seal === 'posted' ? 'approved' : 'denied',
        expectedHash: s.actionHash,
      })
      if (seal === 'posted') {
        const held = await seals.reserve(guild, s.id, jobKey)
        if (held.ok) {
          await seals.consume(guild, s.id, { text: jobKey, token: held.token })
        }
      }
    }
  }
  return { guild, quest, deps: { ledger, quests, sealStore: seals } }
}

describe('costPerPost', () => {
  test('counts only Quests whose Seal was posted, per Campaign and overall', async () => {
    const w = await world()
    await w.quest('a', 'spring', 3000, 'posted')
    await w.quest('b', 'spring', 1000, 'posted')
    await w.quest('c', 'spring', 5000, 'denied')
    await w.quest('d', undefined, 600, 'posted')
    await w.quest('e', 'summer', 9000, null)
    const report = await costPerPost(w.deps, w.guild, { limit: 10 })
    expect(report.overall).toEqual({ posts: 3, costMicros: 4600, costPerPostMicros: 1533 })
    expect(report.campaigns).toEqual([
      { campaignId: null, posts: 1, costMicros: 600, costPerPostMicros: 600 },
      { campaignId: 'spring', posts: 2, costMicros: 4000, costPerPostMicros: 2000 },
    ])
    expect(report.next).toBeNull()
  })

  test('a posted Quest with no metered spend still counts as a post', async () => {
    const w = await world()
    await w.quest('a', 'spring', 3000, 'posted')
    await w.quest('b', 'spring', 0, 'posted')
    const report = await costPerPost(w.deps, w.guild, { limit: 10 })
    expect(report.overall).toEqual({ posts: 2, costMicros: 3000, costPerPostMicros: 1500 })
    expect(report.campaigns).toEqual([
      { campaignId: 'spring', posts: 2, costMicros: 3000, costPerPostMicros: 1500 },
    ])
  })

  test('pages through Campaigns with a cursor', async () => {
    const w = await world()
    await w.quest('a', 'spring', 3000, 'posted')
    await w.quest('d', undefined, 600, 'posted')
    const first = await costPerPost(w.deps, w.guild, { limit: 1 })
    expect(first.campaigns.map((c) => c.campaignId)).toEqual([null])
    expect(first.next).not.toBeNull()
    const second = await costPerPost(w.deps, w.guild, {
      limit: 1,
      ...(first.next === null ? {} : { after: first.next }),
    })
    expect(second.campaigns.map((c) => c.campaignId)).toEqual(['spring'])
    expect(second.next).toBeNull()
  })
})
