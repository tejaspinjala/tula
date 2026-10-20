import { describe, expect, test } from 'bun:test'
import type { NewResearchCall, ResearchStore } from './research-store'

/** A store under test; a database-backed store needs real guilds. */
export interface ResearchStoreFixture {
  store: ResearchStore
  newGuild: () => Promise<string>
}

const T0 = new Date('2026-01-01T00:00:00.000Z')
const T1 = new Date('2026-01-01T01:00:00.000Z')
const CUTOFF = new Date('2026-01-01T00:30:00.000Z')

function call(over: Partial<NewResearchCall> = {}): NewResearchCall {
  return {
    hallId: 'h-forge',
    questId: crypto.randomUUID(),
    memberId: 'm-ada',
    maxPerQuest: 3,
    at: T0,
    ...over,
  }
}

/** The ResearchStore contract, run against every adapter. `make` returns a fresh store. */
export function researchStoreContract(name: string, make: () => Promise<ResearchStoreFixture>) {
  describe(`ResearchStore contract: ${name}`, () => {
    test('calls are counted per Quest and refused past the cap', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const questId = crypto.randomUUID()
      for (const n of [1, 2]) {
        const r = await store.reserve(g, call({ questId, maxPerQuest: 2 }))
        expect(r.ok).toBe(true)
        expect(await store.count(g, questId)).toBe(n)
      }
      expect(await store.reserve(g, call({ questId, maxPerQuest: 2 }))).toEqual({
        ok: false,
        error: 'research_cap',
      })
      expect(await store.count(g, questId)).toBe(2)
    })

    test('a cap of zero refuses every call', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      expect(await store.reserve(g, call({ maxPerQuest: 0 }))).toEqual({
        ok: false,
        error: 'research_cap',
      })
    })

    test('releasing a call frees its slot, and releasing twice is harmless', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const questId = crypto.randomUUID()
      const first = await store.reserve(g, call({ questId, maxPerQuest: 1 }))
      if (!first.ok) {
        throw new Error('expected a slot')
      }
      await store.release(g, first.call.id)
      await store.release(g, first.call.id)
      expect(await store.count(g, questId)).toBe(0)
      expect((await store.reserve(g, call({ questId, maxPerQuest: 1 }))).ok).toBe(true)
    })

    test('same-tick calls never exceed the cap', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const questId = crypto.randomUUID()
      const results = await Promise.all(
        Array.from({ length: 6 }, () => store.reserve(g, call({ questId, maxPerQuest: 2 })))
      )
      expect(results.filter((r) => r.ok)).toHaveLength(2)
      expect(await store.count(g, questId)).toBe(2)
    })

    test('one guild never sees or frees another guild’s calls', async () => {
      const { store, newGuild } = await make()
      const a = await newGuild()
      const b = await newGuild()
      const questId = crypto.randomUUID()
      const mine = await store.reserve(a, call({ questId, maxPerQuest: 1 }))
      if (!mine.ok) {
        throw new Error('expected a slot')
      }
      expect(await store.count(b, questId)).toBe(0)
      await store.release(b, mine.call.id)
      expect(await store.count(a, questId)).toBe(1)
      // The other guild's cap is its own.
      expect((await store.reserve(b, call({ questId, maxPerQuest: 1 }))).ok).toBe(true)
    })

    test('stale lists only unsettled slots older than the cutoff; closing frees or keeps them', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const questId = crypto.randomUUID()
      const stale = await store.reserve(g, call({ questId, maxPerQuest: 5 }))
      const settled = await store.reserve(g, call({ questId, maxPerQuest: 5 }))
      const charged = await store.reserve(g, call({ questId, maxPerQuest: 5 }))
      const fresh = await store.reserve(g, call({ questId, maxPerQuest: 5, at: T1 }))
      if (!stale.ok || !settled.ok || !charged.ok || !fresh.ok) {
        throw new Error('expected slots')
      }
      await store.settle(g, settled.call.id)
      expect(await store.stale(g, CUTOFF, 10)).toEqual([stale.call.id, charged.call.id].sort())
      await store.close(g, stale.call.id, 'freed')
      await store.close(g, charged.call.id, 'settled')
      expect(await store.stale(g, CUTOFF, 10)).toEqual([])
      // Idempotent, and a freed slot is out of the cap while a charged one keeps its place.
      await store.close(g, stale.call.id, 'freed')
      expect(await store.count(g, questId)).toBe(3)
    })

    test('stale honours the limit', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      for (const _ of [1, 2, 3]) {
        await store.reserve(g, call({ maxPerQuest: 5 }))
      }
      expect(await store.stale(g, CUTOFF, 2)).toHaveLength(2)
    })

    test('one guild never sees or closes another guild’s stale slots', async () => {
      const { store, newGuild } = await make()
      const a = await newGuild()
      const b = await newGuild()
      const questId = crypto.randomUUID()
      const mine = await store.reserve(a, call({ questId }))
      if (!mine.ok) {
        throw new Error('expected a slot')
      }
      expect(await store.stale(b, CUTOFF, 10)).toEqual([])
      await store.close(b, mine.call.id, 'freed')
      expect(await store.count(a, questId)).toBe(1)
      expect(await store.stale(a, CUTOFF, 10)).toEqual([mine.call.id])
    })
  })
}
