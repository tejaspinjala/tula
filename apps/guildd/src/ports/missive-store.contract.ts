import { describe, expect, test } from 'bun:test'
import { type MissiveStore, type NewMissive, WHOLE_HALL } from './missive-store'

/** A store under test; a database-backed store needs real guilds. */
export interface MissiveStoreFixture {
  store: MissiveStore
  newGuild: () => Promise<string>
}

const T0 = new Date('2026-01-01T00:00:00.000Z')

function sent(over: Partial<NewMissive> = {}): NewMissive {
  return {
    hallId: 'h-forge',
    questId: crypto.randomUUID(),
    attempt: 1,
    from: 'm-ada',
    to: WHOLE_HALL,
    text: 'hello',
    maxPerQuest: 20,
    at: T0,
    ...over,
  }
}

/** The MissiveStore contract, run against every adapter. `make` returns a fresh store. */
export function missiveStoreContract(name: string, make: () => Promise<MissiveStoreFixture>) {
  describe(`MissiveStore contract: ${name}`, () => {
    test('a sent Missive is listed newest first with its sender, addressee and text', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const questId = crypto.randomUUID()
      await store.send(g, sent({ questId, text: 'first' }))
      await store.send(g, sent({ questId, to: 'm-bo', text: 'second' }))
      const page = await store.list(g, { hallId: 'h-forge', limit: 10 })
      expect(page.missives.map((m) => [m.from, m.to, m.text])).toEqual([
        ['m-ada', 'm-bo', 'second'],
        ['m-ada', WHOLE_HALL, 'first'],
      ])
      expect(page.next).toBeNull()
    })

    test('pages walk newest to oldest with a cursor and never repeat a Missive', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const questId = crypto.randomUUID()
      for (const n of [1, 2, 3, 4, 5]) {
        await store.send(g, sent({ questId, text: `m${n}` }))
      }
      const first = await store.list(g, { hallId: 'h-forge', limit: 2 })
      expect(first.missives.map((m) => m.text)).toEqual(['m5', 'm4'])
      expect(first.next).not.toBeNull()
      const second = await store.list(g, {
        hallId: 'h-forge',
        limit: 2,
        ...(first.next === null ? {} : { after: first.next }),
      })
      expect(second.missives.map((m) => m.text)).toEqual(['m3', 'm2'])
      const last = await store.list(g, {
        hallId: 'h-forge',
        limit: 2,
        ...(second.next === null ? {} : { after: second.next }),
      })
      expect(last.missives.map((m) => m.text)).toEqual(['m1'])
      expect(last.next).toBeNull()
    })

    test('a list holds only its own Hall', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      await store.send(g, sent({ hallId: 'h-forge', text: 'forge talk' }))
      await store.send(g, sent({ hallId: 'h-herald', text: 'herald talk' }))
      const page = await store.list(g, { hallId: 'h-herald', limit: 10 })
      expect(page.missives.map((m) => m.text)).toEqual(['herald talk'])
    })

    test('a Member sees what it sent, what came to it and what went to the Hall, nothing else', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const questId = crypto.randomUUID()
      await store.send(g, sent({ questId, from: 'm-ada', to: 'm-bo', text: 'ada to bo' }))
      await store.send(g, sent({ questId, from: 'm-cy', to: 'm-ada', text: 'cy to ada' }))
      await store.send(g, sent({ questId, from: 'm-cy', to: 'm-bo', text: 'cy to bo' }))
      await store.send(g, sent({ questId, from: 'm-cy', to: WHOLE_HALL, text: 'cy to all' }))
      const page = await store.list(g, { hallId: 'h-forge', member: 'm-ada', limit: 10 })
      expect(page.missives.map((m) => m.text)).toEqual(['cy to all', 'cy to ada', 'ada to bo'])
    })

    test('since keeps only Missives sent after that instant', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const questId = crypto.randomUUID()
      await store.send(g, sent({ questId, text: 'old', at: new Date(T0.getTime()) }))
      await store.send(g, sent({ questId, text: 'new', at: new Date(T0.getTime() + 60_000) }))
      const page = await store.list(g, {
        hallId: 'h-forge',
        since: new Date(T0.getTime() + 1000),
        limit: 10,
      })
      expect(page.missives.map((m) => m.text)).toEqual(['new'])
    })

    test('a Quest is capped across attempts, and a refused send stores nothing', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const questId = crypto.randomUUID()
      const cap = { questId, maxPerQuest: 2 }
      expect((await store.send(g, sent({ ...cap, text: 'a' }))).ok).toBe(true)
      expect((await store.send(g, sent({ ...cap, attempt: 2, text: 'b' }))).ok).toBe(true)
      expect(await store.send(g, sent({ ...cap, attempt: 2, text: 'c' }))).toEqual({
        ok: false,
        error: 'missive_cap',
      })
      expect((await store.list(g, { hallId: 'h-forge', limit: 10 })).missives).toHaveLength(2)
      expect((await store.send(g, sent({ questId: crypto.randomUUID(), text: 'x' }))).ok).toBe(true)
    })

    test('the same send again in one attempt returns the first Missive, even in one tick', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const input = sent({ text: 'once' })
      const results = await Promise.all([store.send(g, input), store.send(g, input)])
      expect(results.map((r) => r.ok && r.created).sort()).toEqual([false, true])
      const [a, b] = results
      expect(a?.ok && b?.ok && a.missive.id === b.missive.id).toBe(true)
      expect((await store.list(g, { hallId: 'h-forge', limit: 10 })).missives).toHaveLength(1)
    })

    test('a repeat is still answered after the cap is reached', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const input = sent({ maxPerQuest: 1, text: 'only' })
      expect((await store.send(g, input)).ok).toBe(true)
      expect(await store.send(g, input)).toMatchObject({ ok: true, created: false })
    })

    test('one guild never lists another guild’s Missives', async () => {
      const { store, newGuild } = await make()
      const a = await newGuild()
      const b = await newGuild()
      await store.send(a, sent({ text: 'secret of A' }))
      expect((await store.list(b, { hallId: 'h-forge', limit: 10 })).missives).toEqual([])
    })

    test('a cross-Hall Missive keeps both Halls and lists in both Halls’ ledgers', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      await store.send(g, sent({ hallId: 'h-forge', toHall: 'h-herald', to: 'm-bo', text: 'over' }))
      await store.send(g, sent({ hallId: 'h-forge', text: 'inside' }))
      const there = await store.list(g, { hallId: 'h-herald', limit: 10 })
      expect(there.missives.map((m) => [m.hallId, m.toHall, m.text])).toEqual([
        ['h-forge', 'h-herald', 'over'],
      ])
      const here = await store.list(g, { hallId: 'h-forge', limit: 10 })
      expect(here.missives.map((m) => [m.hallId, m.toHall, m.text])).toEqual([
        ['h-forge', null, 'inside'],
        ['h-forge', 'h-herald', 'over'],
      ])
    })

    test('a cross-Hall Missive reaches the addressed Member or the whole receiving Hall only', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const questId = crypto.randomUUID()
      const away = { questId, hallId: 'h-forge', toHall: 'h-herald' }
      await store.send(g, sent({ ...away, to: 'm-bo', text: 'to bo' }))
      await store.send(g, sent({ ...away, to: WHOLE_HALL, text: 'to heralds' }))
      const bo = await store.list(g, { hallId: 'h-herald', member: 'm-bo', limit: 10 })
      expect(bo.missives.map((m) => m.text)).toEqual(['to heralds', 'to bo'])
      const cy = await store.list(g, { hallId: 'h-herald', member: 'm-cy', limit: 10 })
      expect(cy.missives.map((m) => m.text)).toEqual(['to heralds'])
      const sender = await store.list(g, { hallId: 'h-forge', member: 'm-ada', limit: 10 })
      expect(sender.missives.map((m) => m.text)).toEqual(['to heralds', 'to bo'])
      const forgeMate = await store.list(g, { hallId: 'h-forge', member: 'm-dee', limit: 10 })
      expect(forgeMate.missives).toEqual([])
    })

    test('cross-Hall sends count against the Quest cap and a different destination is a different send', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const cap = { questId: crypto.randomUUID(), maxPerQuest: 2, toHall: 'h-herald' }
      expect((await store.send(g, sent({ ...cap, text: 'a' }))).ok).toBe(true)
      expect((await store.send(g, sent({ ...cap, toHall: 'h-other', text: 'a' }))).ok).toBe(true)
      expect(await store.send(g, sent({ ...cap, text: 'c' }))).toEqual({
        ok: false,
        error: 'missive_cap',
      })
    })
  })
}
