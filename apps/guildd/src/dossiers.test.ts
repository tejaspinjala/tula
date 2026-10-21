import { describe, expect, test } from 'bun:test'
import { MemoryClock } from './adapters/memory-clock'
import { MemoryDossierStore } from './adapters/memory-dossier-store'
import { MemoryHandoffStore } from './adapters/memory-handoff-store'
import { MemoryObjectStore } from './adapters/memory-object-store'
import { MemoryProposalStore } from './adapters/memory-proposal-store'
import { MemoryQuestQueue } from './adapters/memory-quest-queue'
import { MemorySealStore } from './adapters/memory-seal-store'
import { DossierService } from './dossiers'
import type { Handoff } from './ports/handoff-store'

const GUILD = crypto.randomUUID()

async function world(dataClass: 'internal' | 'private') {
  const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))
  const quests = new MemoryQuestQueue(clock, () => 0.5)
  const handoffs = new MemoryHandoffStore()
  const { quest } = await quests.post(GUILD, {
    jobKey: 'k',
    templateId: 'herald-brief',
    hallId: 'heralds',
    rank: 'journeyman',
    dataClass,
    title: 'Brief',
    ownerId: 'heralds-member-2',
    doneCondition: 'Done',
    roundLimit: 2,
  })
  await quests.claim(GUILD, { leaseMs: 60_000, maxActive: 5, hallCaps: {}, questId: quest.id })
  const handoff: Handoff = {
    goal: 'The private goal',
    doneCondition: 'Done',
    met: true,
    evidence: [],
    openItems: [],
    artifacts: [],
  }
  await handoffs.record(GUILD, quest.id, 1, 'heralds-member-2', handoff)
  await quests.complete(GUILD, quest.id, 1)
  const service = new DossierService({
    quests,
    handoffs,
    objectStore: new MemoryObjectStore(),
    proposals: new MemoryProposalStore(clock),
    seals: new MemorySealStore(clock),
    store: new MemoryDossierStore(),
    clock,
  })
  return { service, quest }
}

const member = { kind: 'member', questId: 'q', hallId: 'scribes', memberId: 'm' } as const

describe('DossierService and private subjects', () => {
  test('refuses a Dossier about a private Quest to a reader outside the private boundary', async () => {
    const { service, quest } = await world('private')
    expect(await service.request(GUILD, quest.id, member)).toEqual({
      ok: false,
      error: 'private_boundary',
    })
  })

  test('builds it for a reader inside the private boundary and for the Guild Master', async () => {
    const { service, quest } = await world('private')
    expect((await service.request(GUILD, quest.id, member, undefined, true)).ok).toBe(true)
    expect((await service.request(GUILD, quest.id, { kind: 'guild_master' })).ok).toBe(true)
  })

  test('an internal Quest needs no private access', async () => {
    const { service, quest } = await world('internal')
    expect((await service.request(GUILD, quest.id, member)).ok).toBe(true)
  })
})
