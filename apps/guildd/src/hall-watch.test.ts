import { describe, expect, test } from 'bun:test'
import { MemoryClock } from './adapters/memory-clock'
import { MemoryModelLedger } from './adapters/memory-model-ledger'
import { MemoryProposalStore } from './adapters/memory-proposal-store'
import { MemoryQuestQueue } from './adapters/memory-quest-queue'
import { MemorySealStore } from './adapters/memory-seal-store'
import { MemoryTripwireStore } from './adapters/memory-tripwire-store'
import { defaultConfig } from './guild-config'
import { watchHalls } from './hall-watch'
import type { NewQuest } from './ports/quest-queue'

const NOW = new Date('2030-01-08T12:00:00.000Z')
const HUGE = { tokens: 1_000_000_000, costMicros: 1_000_000_000 }

function world() {
  const base = defaultConfig()
  const heralds = base.halls[0]
  if (!heralds) {
    throw new Error('no default hall')
  }
  const config = { ...base, halls: [heralds, { ...heralds, id: 'smiths' }] }
  const clock = new MemoryClock(NOW)
  const tripwires = new MemoryTripwireStore(clock)
  const quests = new MemoryQuestQueue(clock, () => 0.5)
  const sealStore = new MemorySealStore(clock)
  const ledger = new MemoryModelLedger()
  const proposals = new MemoryProposalStore(clock)
  const guild = crypto.randomUUID()
  const deps = {
    config: { current: async () => ({ version: 1, config }) },
    tripwires,
    ledger,
    quests,
    sealStore,
    proposals,
    clock,
  }
  /** Records `tokens` used by `hallId` on `day`. */
  const spend = async (hallId: string, day: string, tokens: number) => {
    const runId = `run-${hallId}-${day}`
    await ledger.openRun(guild, {
      runId,
      questId: 'q',
      attempt: 1,
      hallId,
      providerId: 'cloud',
      profileId: 'cloud-mid',
      state: 'active',
      tokenHash: `hash-${runId}`,
      expiresAt: null,
    })
    await ledger.reserve(guild, {
      callKey: `call-${runId}`,
      runId,
      day,
      inputTokens: tokens,
      outputTokens: 0,
      costMicros: 0,
      clientKey: null,
      caps: HUGE,
    })
  }
  const quest = async (hallId: string, over: Partial<NewQuest> = {}) =>
    (
      await quests.post(guild, {
        jobKey: crypto.randomUUID(),
        templateId: 'herald-brief',
        hallId,
        rank: 'journeyman',
        dataClass: 'internal',
        title: 'Brief',
        ownerId: 'heralds-member-2',
        doneCondition: 'A draft brief is filed',
        roundLimit: 2,
        ...over,
      })
    ).quest
  return { deps, guild, spend, quest, clock, sealStore, proposals }
}

describe('watchHalls', () => {
  test('a token burn pauses only the Hall that burned, not every Hall', async () => {
    const w = world()
    for (let d = 1; d <= 7; d++) {
      await w.spend('heralds', `2030-01-0${d}`, 100)
      await w.spend('smiths', `2030-01-0${d}`, 100)
    }
    await w.spend('heralds', '2030-01-08', 1000)
    await w.spend('smiths', '2030-01-08', 100)
    expect(await watchHalls(w.deps, w.guild)).toEqual(['heralds'])
  })
})
