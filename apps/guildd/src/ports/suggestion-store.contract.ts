import { describe, expect, test } from 'bun:test'
import type { NewSuggestion, SuggestionStore } from './suggestion-store'

/** A store under test and a way to get real guilds. */
export interface SuggestionStoreFixture {
  store: SuggestionStore
  newGuild: () => Promise<string>
}

const item = (n: number): NewSuggestion => ({
  sourceId: `pr:o/r#${n}`,
  repo: 'o/r',
  kind: 'pr',
  title: `o/r#${n}: change ${n}`,
  body: `body ${n}`,
  url: `https://github.com/o/r/pull/${n}`,
})

/** The SuggestionStore contract, run against every adapter. `make` returns a fresh store. */
export function suggestionStoreContract(name: string, make: () => Promise<SuggestionStoreFixture>) {
  describe(`SuggestionStore contract: ${name}`, () => {
    test('stored suggestions start pending and round-trip', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      expect(await store.addMany(g, [item(1)])).toBe(1)
      const { suggestions } = await store.list(g, { limit: 10 })
      expect(suggestions).toHaveLength(1)
      expect(suggestions[0]).toMatchObject({
        ...item(1),
        status: 'pending',
        noteId: null,
        decidedAt: null,
      })
      const first = suggestions[0]
      expect(await store.get(g, first?.id ?? '')).toEqual(first ?? null)
    })

    test('a source id is stored once, including when it repeats in one call or across calls', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      expect(await store.addMany(g, [item(1), item(1), item(2)])).toBe(2)
      expect(await store.addMany(g, [item(2), item(3)])).toBe(1)
      expect((await store.list(g, { limit: 10 })).suggestions).toHaveLength(3)
    })

    test('a decided suggestion is never suggested again', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      await store.addMany(g, [item(1), item(2)])
      const [a, b] = (await store.list(g, { limit: 10 })).suggestions
      expect((await store.decide(g, a?.id ?? '', 'dismissed')).ok).toBe(true)
      expect((await store.decide(g, b?.id ?? '', 'accepted')).ok).toBe(true)
      expect(await store.addMany(g, [item(1), item(2)])).toBe(0)
      expect((await store.list(g, { limit: 10, status: 'pending' })).suggestions).toEqual([])
      expect(
        (await store.list(g, { limit: 10, status: 'dismissed' })).suggestions.map((s) => s.sourceId)
      ).toEqual([a?.sourceId ?? ''])
    })

    test('a decision is made once: the second says already decided, an unknown id is not found', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      await store.addMany(g, [item(1)])
      const id = (await store.list(g, { limit: 1 })).suggestions[0]?.id ?? ''
      const first = await store.decide(g, id, 'accepted')
      expect(first).toMatchObject({ ok: true, suggestion: { status: 'accepted' } })
      expect(await store.decide(g, id, 'dismissed')).toEqual({
        ok: false,
        reason: 'already_decided',
      })
      expect(await store.decide(g, crypto.randomUUID(), 'dismissed')).toEqual({
        ok: false,
        reason: 'not_found',
      })
    })

    test('two racing decisions in one tick: exactly one wins', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      await store.addMany(g, [item(1)])
      const id = (await store.list(g, { limit: 1 })).suggestions[0]?.id ?? ''
      const results = await Promise.all([
        store.decide(g, id, 'accepted'),
        store.decide(g, id, 'accepted'),
        store.decide(g, id, 'dismissed'),
      ])
      expect(results.filter((r) => r.ok)).toHaveLength(1)
    })

    test('recordNote keeps the note id; reopen returns an accepted suggestion to pending', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      await store.addMany(g, [item(1), item(2)])
      const [a, b] = (await store.list(g, { limit: 10 })).suggestions
      const noteId = crypto.randomUUID()
      await store.decide(g, a?.id ?? '', 'accepted')
      await store.recordNote(g, a?.id ?? '', noteId)
      expect(await store.get(g, a?.id ?? '')).toMatchObject({ status: 'accepted', noteId })
      await store.decide(g, b?.id ?? '', 'accepted')
      await store.reopen(g, b?.id ?? '')
      expect(await store.get(g, b?.id ?? '')).toMatchObject({
        status: 'pending',
        noteId: null,
        decidedAt: null,
      })
    })

    test('lists are paginated in id order without gaps or repeats', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      await store.addMany(g, [1, 2, 3, 4, 5].map(item))
      const seen: string[] = []
      let after: string | undefined
      for (let i = 0; i < 5; i++) {
        const page = await store.list(g, { limit: 2, ...(after ? { after } : {}) })
        seen.push(...page.suggestions.map((s) => s.id))
        if (page.next === null) {
          break
        }
        after = page.next
      }
      expect(seen).toHaveLength(5)
      expect(new Set(seen).size).toBe(5)
      expect([...seen].sort()).toEqual(seen)
    })

    test("a guild never sees or decides another guild's suggestions", async () => {
      const { store, newGuild } = await make()
      const a = await newGuild()
      const b = await newGuild()
      await store.addMany(a, [item(1)])
      const id = (await store.list(a, { limit: 1 })).suggestions[0]?.id ?? ''
      expect((await store.list(b, { limit: 10 })).suggestions).toEqual([])
      expect(await store.get(b, id)).toBeNull()
      expect(await store.decide(b, id, 'dismissed')).toEqual({ ok: false, reason: 'not_found' })
      expect(await store.addMany(b, [item(1)])).toBe(1)
      expect(await store.get(a, id)).toMatchObject({ status: 'pending' })
    })
  })
}
