import { describe, expect, test } from 'bun:test'
import { MemoryClock } from './adapters/memory-clock'
import { MemoryQuestQueue } from './adapters/memory-quest-queue'
import { MemorySealStore } from './adapters/memory-seal-store'
import { reconcileSeals } from './core-loop'
import { SEAL_TTL_MS } from './ports/seal-store'

async function setup(roundLimit = 2) {
  const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))
  const quests = new MemoryQuestQueue(clock, () => 0.5)
  const seals = new MemorySealStore(clock)
  const guild = crypto.randomUUID()
  const { quest } = await quests.post(guild, {
    jobKey: 'k',
    templateId: 'herald-announcement',
    hallId: 'heralds',
    rank: 'apprentice',
    dataClass: 'public',
    title: 'Announce',
    ownerId: 'heralds-member-1',
    doneCondition: 'An announcement draft is ready for a Seal',
    roundLimit,
  })
  const claimed = await quests.claim(guild, { leaseMs: 60_000, maxActive: 5 })
  const held = await quests.submitForSeal(guild, quest.id, claimed?.attempts ?? 0)
  const ask = (round: number) =>
    seals.request(guild, {
      questId: quest.id,
      requestedBy: 'heralds-member-1',
      kind: 'post',
      text: 'Hello',
      evidence: 'verdict: pass',
      round,
    })
  const deps = { quests, seals }
  return { clock, quests, seals, guild, quest: held, ask, deps }
}

describe('reconcileSeals', () => {
  test('a consumed Seal finishes its Quest', async () => {
    const s = await setup()
    const seal = await s.ask(1)
    await s.seals.decide(s.guild, seal.id, { verdict: 'approved', expectedHash: seal.actionHash })
    expect((await reconcileSeals(s.deps, s.guild)).settled).toBe(0)
    expect((await s.quests.get(s.guild, s.quest.id))?.state).toBe('awaiting_seal')
    await s.seals.markPosted(s.guild, seal.id, 'Hello', { reauthenticated: true })
    expect((await reconcileSeals(s.deps, s.guild)).settled).toBe(1)
    expect((await s.quests.get(s.guild, s.quest.id))?.state).toBe('done')
  })

  test('a denied Seal queues a revision round; an expired one on the last round dead-letters', async () => {
    const s = await setup(2)
    const first = await s.ask(1)
    await s.seals.decide(s.guild, first.id, { verdict: 'denied', expectedHash: first.actionHash })
    await reconcileSeals(s.deps, s.guild)
    expect((await s.quests.get(s.guild, s.quest.id))?.state).toBe('queued')
    const again = await s.quests.claim(s.guild, { leaseMs: 60_000, maxActive: 5 })
    await s.quests.submitForSeal(s.guild, s.quest.id, again?.attempts ?? 0)
    await s.ask(2)
    s.clock.advance(SEAL_TTL_MS + 1)
    await reconcileSeals(s.deps, s.guild)
    expect((await s.quests.get(s.guild, s.quest.id))?.state).toBe('dead')
  })

  test('a Seal still waiting leaves the Quest held', async () => {
    const s = await setup()
    await s.ask(1)
    expect((await reconcileSeals(s.deps, s.guild)).settled).toBe(0)
    expect((await s.quests.get(s.guild, s.quest.id))?.state).toBe('awaiting_seal')
  })
})
