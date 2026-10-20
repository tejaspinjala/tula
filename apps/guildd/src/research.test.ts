import { afterAll, describe, expect, test } from 'bun:test'
import { MemoryClock } from './adapters/memory-clock'
import { MemoryConfigStore } from './adapters/memory-config-store'
import { MemoryKeyProvider } from './adapters/memory-key-provider'
import { MemoryPageFetcher } from './adapters/memory-page-fetcher'
import { MemoryResearchStore } from './adapters/memory-research-store'
import { MemorySearchProvider } from './adapters/memory-search-provider'
import { MemoryTreasuryStore } from './adapters/memory-treasury-store'
import { PgResearchStore } from './adapters/pg-research-store'
import { PgTreasuryStore } from './adapters/pg-treasury-store'
import { createDb } from './db/client'
import type { Quest } from './ports/quest-queue'
import type { SearchHit, SearchProvider } from './ports/search-provider'
import { Research } from './research'
import { foundTestGuild } from './testing/found-guild'
import { testDbUrl } from './testing/test-db'
import { Treasury } from './treasury'

const COST = 2
const HITS: SearchHit[] = [{ title: 'Bun', url: 'https://bun.sh/docs', snippet: 'fast' }]
const TEN_MINUTES = 10 * 60_000

function build(search?: SearchProvider) {
  const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))
  const config = new MemoryConfigStore(clock)
  const treasuryStore = new MemoryTreasuryStore(clock)
  const treasury = new Treasury({ store: treasuryStore, config })
  const store = new MemoryResearchStore()
  const research = new Research({
    search: search ?? new MemorySearchProvider({ results: HITS }),
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

async function allowResearch(config: MemoryConfigStore, guild: string): Promise<void> {
  await config.seed(guild)
  const { config: current } = await config.current(guild)
  const proposed = await config.propose(guild, {
    ...current,
    caps: { ...current.caps, maxResearchPerQuest: 2 },
  })
  if (proposed.status === 'pending') {
    await config.confirm(guild, proposed.version)
  }
}

const quest = (id: string): Quest => {
  // Only the fields `run` reads; the rest of a Quest is not part of this seam.
  const partial = { id, hallId: 'h-forge', dataClass: 'standard' }
  return partial as Quest
}

describe('Research.sweep', () => {
  test('a spend reserved but never recorded on the slot is still released, with its slot, past the deadline', async () => {
    const { clock, config, treasury, treasuryStore, store, research } = build()
    const guild = crypto.randomUUID()
    await config.seed(guild)
    const questId = crypto.randomUUID()
    // What `run` did before the crash: took a slot, reserved the spend under its key.
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
    const before = (await treasury.overview(guild)).balances.operating

    expect(await research.sweep(guild)).toBe(0)
    clock.advance(TEN_MINUTES)
    expect(await research.sweep(guild)).toBe(1)
    expect((await treasuryStore.getSpend(guild, spend.spend.id))?.status).toBe('released')
    expect((await treasury.overview(guild)).balances.operating).toBe(before + COST)
    expect(await store.count(guild, questId)).toBe(0)
    expect(await research.sweep(guild)).toBe(0)
  })

  test('a slot with no spend at all is freed', async () => {
    const { clock, config, store, research } = build()
    const guild = crypto.randomUUID()
    await config.seed(guild)
    const questId = crypto.randomUUID()
    await store.reserve(guild, {
      hallId: 'h-forge',
      questId,
      memberId: 'm-ada',
      maxPerQuest: 3,
      at: clock.now(),
    })
    clock.advance(TEN_MINUTES)
    expect(await research.sweep(guild)).toBe(1)
    expect(await store.count(guild, questId)).toBe(0)
  })

  test('a finished call is untouched by the sweep', async () => {
    const { clock, config, treasuryStore, store, research } = build()
    const guild = crypto.randomUUID()
    await allowResearch(config, guild)
    const q = quest(crypto.randomUUID())
    const out = await research.run(guild, { quest: q, member: 'm-ada' }, 'bun')
    expect(out).toMatchObject({ ok: true })
    clock.advance(TEN_MINUTES)
    expect(await research.sweep(guild)).toBe(0)
    expect(await store.count(guild, q.id)).toBe(1)
    const [spend] = (await treasuryStore.listSpends(guild, { limit: 10 })).items
    expect(spend?.status).toBe('settled')
  })

  test('a call the sweep released mid-flight is not returned as charged, and the ledger shows one release and no settle', async () => {
    let open: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const slow: SearchProvider = {
      id: 'slow',
      privateEligible: false,
      search: async () => {
        await gate
        return HITS
      },
    }
    const { clock, config, treasuryStore, store, research } = build(slow)
    const guild = crypto.randomUUID()
    await allowResearch(config, guild)
    const q = quest(crypto.randomUUID())
    const running = research.run(guild, { quest: q, member: 'm-ada' }, 'bun')
    await Bun.sleep(0)
    clock.advance(TEN_MINUTES)
    expect(await research.sweep(guild)).toBe(1)
    open()
    expect(await running).toEqual({ ok: false, error: 'research_timeout' })
    const kinds = (await treasuryStore.listEntries(guild, { limit: 50 })).items.map((e) => e.kind)
    expect(kinds.filter((k) => k === 'spend_release')).toHaveLength(1)
    expect(kinds.filter((k) => k === 'spend_settle')).toHaveLength(0)
    expect(await store.count(guild, q.id)).toBe(0)
  })

  test('a slot whose spend was in fact settled is kept, not freed', async () => {
    const { clock, config, treasury, treasuryStore, store, research } = build()
    const guild = crypto.randomUUID()
    await config.seed(guild)
    const questId = crypto.randomUUID()
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
    // Crash after the charge was settled but before the slot was marked.
    await treasury.settleSpend(guild, spend.spend.id, COST, 'm-ada')
    clock.advance(TEN_MINUTES)
    expect(await research.sweep(guild)).toBe(0)
    expect(await store.count(guild, questId)).toBe(1)
    expect((await treasuryStore.getSpend(guild, spend.spend.id))?.status).toBe('settled')
    expect(await store.stale(guild, clock.now(), 10)).toEqual([])
  })
})

describe('Research.sweep on Postgres with a one-connection pool', () => {
  const db = createDb(testDbUrl('app'), { max: 1 })
  afterAll(async () => {
    await db.close()
  })

  test('releases the spend without deadlocking on the pool', async () => {
    const keys = new MemoryKeyProvider()
    const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))
    const config = new MemoryConfigStore(clock)
    const guild = await foundTestGuild(db, { name: 'Sweep', goal: 'g' }, keys)
    await config.seed(guild)
    const treasuryStore = new PgTreasuryStore(db, keys, clock)
    const treasury = new Treasury({ store: treasuryStore, config })
    const store = new PgResearchStore(db)
    const research = new Research({
      search: new MemorySearchProvider({ results: HITS }),
      fetcher: new MemoryPageFetcher({}),
      store,
      treasury,
      config,
      clock,
      costCents: COST,
    })
    const questId = crypto.randomUUID()
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
    clock.advance(TEN_MINUTES)
    expect(await research.sweep(guild)).toBe(1)
    expect((await treasuryStore.getSpend(guild, spend.spend.id))?.status).toBe('released')
    expect(await store.count(guild, questId)).toBe(0)
  })
})
