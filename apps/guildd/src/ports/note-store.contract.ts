import { describe, expect, test } from 'bun:test'
import { NoteError, type NoteStore } from './note-store'

/** A store under test; a database-backed store needs real guilds. */
export interface NoteStoreFixture {
  store: NoteStore
  newGuild: () => Promise<string>
}

const fact = { kind: 'text', claim: 'fact', evidence: 'ticket #1' } as const

/** The NoteStore contract, run against every adapter. `make` returns a fresh store. */
export function noteStoreContract(name: string, make: () => Promise<NoteStoreFixture>) {
  describe(`NoteStore contract: ${name}`, () => {
    test('adding then editing keeps every version', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const note = await store.add(g, { ...fact, title: 'Deploys', body: 'ship on friday' })
      expect(note).toMatchObject({ version: 1, trust: 'fact', evidence: 'ticket #1' })
      const edited = await store.edit(g, note.id, { body: 'never ship on friday' })
      expect(edited).toMatchObject({ id: note.id, version: 2, title: 'Deploys' })
      const detail = await store.get(g, note.id)
      expect(detail?.note.body).toBe('never ship on friday')
      expect(detail?.versions.map((v) => [v.version, v.body])).toEqual([
        [1, 'ship on friday'],
        [2, 'never ship on friday'],
      ])
    })

    test('adding with the same idempotency key twice, even in one tick, makes one note', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const input = { kind: 'text', claim: 'assumption', title: 'Once', body: 'b' } as const
      const [a, b] = await Promise.all([
        store.add(g, input, undefined, 'learning:1'),
        store.add(g, input, undefined, 'learning:1'),
      ])
      expect(b.id).toBe(a.id)
      const again = await store.add(g, input, undefined, 'learning:1')
      expect(again.id).toBe(a.id)
      const other = await store.add(g, input, undefined, 'learning:2')
      expect(other.id).not.toBe(a.id)
      expect((await store.list(g, { limit: 10 })).notes).toHaveLength(2)
      const elsewhere = await newGuild()
      const mine = await store.add(elsewhere, input, undefined, 'learning:1')
      expect(mine.id).not.toBe(a.id)
    })

    test('a fact without evidence is rejected; an assumption is quarantined', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const bad = store.add(g, { kind: 'text', claim: 'fact', title: 'T', body: 'b' })
      await expect(bad).rejects.toMatchObject({ code: 'evidence_required' })
      await expect(bad).rejects.toBeInstanceOf(NoteError)
      const guess = await store.add(g, { kind: 'text', claim: 'assumption', title: 'G', body: 'b' })
      expect(guess.trust).toBe('quarantined')
      await expect(store.edit(g, guess.id, { claim: 'fact' })).rejects.toMatchObject({
        code: 'evidence_required',
      })
      const promoted = await store.edit(g, guess.id, { claim: 'fact', evidence: 'measured' })
      expect(promoted).toMatchObject({ trust: 'fact', evidence: 'measured', version: 2 })
    })

    test('editing an unknown note is not_found', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      await expect(store.edit(g, crypto.randomUUID(), { title: 'x' })).rejects.toMatchObject({
        code: 'not_found',
      })
      expect(await store.get(g, crypto.randomUUID())).toBeNull()
    })

    test('a [[wiki link]] creates a backlink on the target, and editing it away removes it', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const target = await store.add(g, { ...fact, title: 'Release Process', body: 'steps' })
      const source = await store.add(g, {
        ...fact,
        title: 'Retro',
        body: 'see [[release process]] and [[Nowhere]]',
      })
      expect((await store.get(g, target.id))?.backlinks).toEqual([
        { id: source.id, title: 'Retro' },
      ])
      await store.edit(g, source.id, { body: 'no links now' })
      expect((await store.get(g, target.id))?.backlinks).toEqual([])
    })

    test('a link note stores a url', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const n = await store.add(g, {
        kind: 'link',
        claim: 'assumption',
        title: 'Docs',
        body: 'https://example.com/docs',
      })
      expect(n.kind).toBe('link')
    })

    test('list is paginated in id order', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      for (const t of ['a', 'b', 'c']) {
        await store.add(g, { ...fact, title: t, body: t })
      }
      const first = await store.list(g, { limit: 2 })
      expect(first.notes).toHaveLength(2)
      expect(first.next).toBe(first.notes[1]?.id ?? '')
      const second = await store.list(g, { after: first.next ?? '', limit: 2 })
      expect(second.notes).toHaveLength(1)
      expect(second.next).toBeNull()
      const ids = [...first.notes, ...second.notes].map((n) => n.id)
      expect(ids).toEqual([...ids].sort())
    })

    test('search matches every term in the current version, case-insensitively, and paginates', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const a = await store.add(g, { ...fact, title: 'Caching', body: 'Redis speeds reads' })
      await store.add(g, { ...fact, title: 'Queues', body: 'Redis streams too' })
      await store.add(g, { ...fact, title: 'Other', body: 'unrelated' })
      const hits = await store.search(g, 'REDIS', { limit: 10 })
      expect(hits.notes.map((n) => n.title).sort()).toEqual(['Caching', 'Queues'])
      const both = await store.search(g, 'redis reads', { limit: 10 })
      expect(both.notes.map((n) => n.id)).toEqual([a.id])
      expect((await store.search(g, 'redis', { limit: 1 })).next).not.toBeNull()
      expect((await store.search(g, '   ', { limit: 10 })).notes).toEqual([])
      await store.edit(g, a.id, { body: 'now memcached' })
      expect((await store.search(g, 'reads', { limit: 10 })).notes).toEqual([])
      const moved = await store.search(g, 'memcached', { limit: 10 })
      expect(moved.notes.map((n) => n.id)).toEqual([a.id])
    })

    test("another guild cannot see, search, edit or link to a guild's notes", async () => {
      const { store, newGuild } = await make()
      const a = await newGuild()
      const b = await newGuild()
      const secret = await store.add(a, { ...fact, title: 'Alpha', body: 'zebra plan' })
      expect((await store.search(b, 'zebra', { limit: 10 })).notes).toEqual([])
      expect((await store.list(b, { limit: 10 })).notes).toEqual([])
      expect(await store.get(b, secret.id)).toBeNull()
      await expect(store.edit(b, secret.id, { title: 'x' })).rejects.toMatchObject({
        code: 'not_found',
      })
      await store.add(b, { ...fact, title: 'Beta', body: 'links [[alpha]]' })
      expect((await store.get(a, secret.id))?.backlinks).toEqual([])
    })

    test('two same-tick edits both land as distinct versions', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const n = await store.add(g, { ...fact, title: 'Race', body: 'v1' })
      await Promise.all([store.edit(g, n.id, { body: 'v2' }), store.edit(g, n.id, { body: 'v3' })])
      expect((await store.get(g, n.id))?.versions.map((v) => v.version)).toEqual([1, 2, 3])
    })

    test('a note filed under one Hall is invisible to another Hall\u2019s filter, whatever its title says', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const a = await store.add(g, { ...fact, title: '[b] x', body: 'shared word' }, 'a')
      const b = await store.add(g, { ...fact, title: 'y', body: 'shared word' }, 'b')
      const open = await store.add(g, { ...fact, title: 'z', body: 'shared word' })
      const page = { limit: 10 }
      expect(
        (await store.search(g, 'shared', { ...page, hall: 'b' })).notes.map((n) => n.id)
      ).toEqual([b.id])
      expect((await store.list(g, { ...page, hall: 'a' })).notes.map((n) => n.id)).toEqual([a.id])
      expect(await store.get(g, a.id, 'b')).toBeNull()
      expect((await store.get(g, a.id, 'a'))?.note.id).toBe(a.id)
      expect(await store.get(g, open.id, 'a')).toBeNull()
      // Unfiltered reads (the Guild Master\u2019s REST routes) still see everything.
      expect((await store.list(g, page)).notes).toHaveLength(3)
    })

    test('with a Hall filter, backlinks come only from notes of that Hall', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const target = await store.add(g, { ...fact, title: 'A', body: 'target' }, 'a')
      await store.add(g, { ...fact, title: 'Linker', body: 'see [[A]]' }, 'b')
      const own = await store.add(g, { ...fact, title: 'Own', body: 'see [[A]]' }, 'a')
      expect((await store.get(g, target.id, 'a'))?.backlinks.map((b) => b.id)).toEqual([own.id])
      expect((await store.get(g, target.id))?.backlinks).toHaveLength(2)
    })

    test('a note carries a data class: internal by default, private when filed as private', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const plain = await store.add(g, { ...fact, title: 'Plain', body: 'p' }, 'a')
      const secret = await store.add(
        g,
        { ...fact, title: 'Secret', body: 's' },
        'a',
        undefined,
        'private'
      )
      expect(plain.dataClass).toBe('internal')
      expect(secret.dataClass).toBe('private')
      const detail = await store.get(g, secret.id, 'a', { includePrivate: true })
      expect(detail?.note.dataClass).toBe('private')
      const edited = await store.edit(g, secret.id, { body: 'changed' })
      expect(edited.dataClass).toBe('private')
    })

    test('private notes are omitted from list, search and get unless the reader asks for them', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const plain = await store.add(g, { ...fact, title: 'Plain', body: 'shared word' }, 'a')
      const secret = await store.add(
        g,
        { ...fact, title: 'Secret', body: 'shared word' },
        'a',
        undefined,
        'private'
      )
      const page = { limit: 10, hall: 'a' }
      expect((await store.list(g, page)).notes.map((n) => n.id)).toEqual([plain.id])
      expect((await store.search(g, 'shared', page)).notes.map((n) => n.id)).toEqual([plain.id])
      expect(await store.get(g, secret.id, 'a')).toBeNull()
      expect(await store.get(g, secret.id)).toBeNull()
      const open = { ...page, includePrivate: true }
      expect((await store.list(g, open)).notes).toHaveLength(2)
      expect((await store.search(g, 'shared', open)).notes).toHaveLength(2)
      expect((await store.get(g, secret.id, 'a', { includePrivate: true }))?.note.id).toBe(
        secret.id
      )
    })

    test('a private note never shows as a backlink to a reader without private access', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const target = await store.add(g, { ...fact, title: 'A', body: 'target' }, 'a')
      await store.add(g, { ...fact, title: 'Linker', body: 'see [[A]]' }, 'a', undefined, 'private')
      expect((await store.get(g, target.id, 'a'))?.backlinks).toEqual([])
      expect(
        (await store.get(g, target.id, 'a', { includePrivate: true }))?.backlinks
      ).toHaveLength(1)
    })

    test('a private note of one guild is invisible to another guild', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const other = await newGuild()
      const secret = await store.add(
        g,
        { ...fact, title: 'Secret', body: 'private words' },
        'a',
        undefined,
        'private'
      )
      const open = { limit: 10, includePrivate: true }
      expect((await store.list(other, open)).notes).toEqual([])
      expect((await store.search(other, 'private', open)).notes).toEqual([])
      expect(await store.get(other, secret.id, undefined, { includePrivate: true })).toBeNull()
    })
  })
}
