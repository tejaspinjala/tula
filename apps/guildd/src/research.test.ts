import { describe, expect, test } from 'bun:test'
import { MemoryClock } from './adapters/memory-clock'
import { MemoryConfigStore } from './adapters/memory-config-store'
import { MemoryPageFetcher } from './adapters/memory-page-fetcher'
import { MemoryResearchStore } from './adapters/memory-research-store'
import { MemorySearchProvider } from './adapters/memory-search-provider'
import { MemoryTreasuryStore } from './adapters/memory-treasury-store'
import type { Quest } from './ports/quest-queue'
import { Research } from './research'
import { Treasury } from './treasury'

const COST = 2

function setup() {
  const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))
  const config = new MemoryConfigStore(clock)
  const treasuryStore = new MemoryTreasuryStore(clock)
  const treasury = new Treasury({ store: treasuryStore, config })
  const store = new MemoryResearchStore()
  const research = new Research({
    search: new MemorySearchProvider({
      results: [{ title: 'Bun', url: 'https://bun.sh/docs', snippet: 'fast' }],
    }),
    fetcher: new MemoryPageFetcher({ 'https://bun.sh/docs': 'Bun docs' }),
    store,
    treasury,
    config,
    clock,
    costCents: COST,
    timeoutMs: 1000,
    retries: 1,
    sleep: async () => {},
    random: () => 0.5,
  })
  return { clock, config, treasury, treasuryStore, store, research }
}

const quest = (id: string): Quest => {
  // Only the fields `run` reads; the rest of a Quest is not part of this seam.
  const partial = { id, hallId: 'h-forge', dataClass: 'standard' }
  return partial as Quest
}

describe('Research.sweep', () => {
  test('a spend left reserved by a crash is released with its slot once past the deadline', async () => {
    const { clock, config, treasury, treasuryStore, store, research } = setup()
    const guild = crypto.randomUUID()
    await config.seed(guild)
    const questId = crypto.randomUUID()
    // What `run` did before the crash: took a slot, reserved the spend, never settled.
    const slot = await store.reserve(guild, {
      hallId: 'h-forge',
      questId,
      memberId: 'm-ada',
      maxPerQuest: 3,
      at: clock.now(),
    })
    if (!slot.ok) {
      throw new Error('expected a slot')
    }
    const spend = await treasury.requestSpend(guild, {
      key: `research:${slot.call.id}`,
      amountCents: COST,
      purpose: 'research',
      requestedBy: 'm-ada',
    })
    if (!spend.ok) {
      throw new Error('expected a spend')
    }
    await store.attachSpend(guild, slot.call.id, spend.spend.id)

    expect(await research.sweep(guild)).toBe(0)
    clock.advance(10 * 60_000)
    expect(await research.sweep(guild)).toBe(1)
    expect((await treasuryStore.getSpend(guild, spend.spend.id))?.status).toBe('released')
    expect(await store.count(guild, questId)).toBe(0)
    expect(await research.sweep(guild)).toBe(0)
  })

  test('a finished call is untouched by the sweep', async () => {
    const { clock, config, treasuryStore, store, research } = setup()
    const guild = crypto.randomUUID()
    await config.seed(guild)
    const { config: current } = await config.current(guild)
    const proposed = await config.propose(guild, {
      ...current,
      caps: { ...current.caps, maxResearchPerQuest: 2 },
    })
    if (proposed.status === 'pending') {
      await config.confirm(guild, proposed.version)
    }
    const q = quest(crypto.randomUUID())
    const out = await research.run(guild, { quest: q, member: 'm-ada' }, 'bun')
    expect(out).toMatchObject({ ok: true })
    clock.advance(10 * 60_000)
    expect(await research.sweep(guild)).toBe(0)
    expect(await store.count(guild, q.id)).toBe(1)
    const [spend] = (await treasuryStore.listSpends(guild, { limit: 10 })).items
    expect(spend?.status).toBe('settled')
  })
})
