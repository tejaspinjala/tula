import { afterAll, expect, test } from 'bun:test'
import postgres from 'postgres'
import { createDb } from '../db/client'
import { noteStoreContract } from '../ports/note-store.contract'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { MemoryKeyProvider } from './memory-key-provider'
import { PgNoteStore } from './pg-note-store'

const db = createDb(testDbUrl('app'))
const owner = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
afterAll(async () => {
  await db.close()
  await owner.end()
})

noteStoreContract('postgres', async () => ({
  store: new PgNoteStore(db, new MemoryKeyProvider()),
  newGuild: () => foundTestGuild(db, { name: 'Archive', goal: 'g' }),
}))

test('note writes append note.added and note.edited events, never the body', async () => {
  const guild = await foundTestGuild(db, { name: 'Archive', goal: 'g' })
  const store = new PgNoteStore(db, new MemoryKeyProvider())
  const n = await store.add(guild, {
    kind: 'text',
    claim: 'fact',
    evidence: 'e',
    title: 'T',
    body: 'secret-body-text',
  })
  await store.edit(guild, n.id, { title: 'T2' })
  const events = await owner`
    select type, payload from events where guild_id = ${guild} and type like 'note.%' order by seq`
  expect(events.map((e) => e.type)).toEqual(['note.added', 'note.edited'])
  expect(JSON.stringify(events)).not.toContain('secret-body-text')
})

test('the app role may update only current_version on notes', async () => {
  const guild = await foundTestGuild(db, { name: 'Archive', goal: 'g' })
  const store = new PgNoteStore(db, new MemoryKeyProvider())
  const n = await store.add(guild, {
    kind: 'text',
    claim: 'fact',
    evidence: 'e',
    title: 'T',
    body: 'b',
  })
  const message = await db
    .withGuild(guild, async (tx) => tx`update notes set kind = 'link' where note_id =${n.id}`)
    .then(
      () => 'ok',
      (e: Error) => e.message
    )
  expect(message).toContain('permission denied')
  const edited = await store.edit(guild, n.id, { title: 'T2' })
  expect(edited.version).toBe(2)
})

test('rekeyLinks rewrites links stored under an old key, only in that guild, and is idempotent', async () => {
  const store = new PgNoteStore(db, new MemoryKeyProvider())
  const fact = { kind: 'text', claim: 'fact', evidence: 'e' } as const
  const a = await foundTestGuild(db, { name: 'A', goal: 'g' })
  const b = await foundTestGuild(db, { name: 'B', goal: 'g' })
  const staleKey = 'cafe\u0301'
  const ids: Record<string, { target: string; source: string }> = {}
  for (const g of [a, b]) {
    const target = await store.add(g, { ...fact, title: 'Café', body: 'b' })
    const source = await store.add(g, { ...fact, title: 'Src', body: 'see [[Cafe\u0301]]' })
    ids[g] = { target: target.id, source: source.id }
    // Simulate a link written before #191: the raw, un-normalised key.
    await owner`delete from note_links where guild_id = ${g} and note_id = ${source.id}`
    await owner`insert into note_links (guild_id, note_id, version, target_key)
      values (${g}, ${source.id}, 1, ${staleKey})`
    expect((await store.get(g, target.id))?.backlinks).toEqual([])
  }
  expect(await store.rekeyLinks(a)).toBe(1)
  expect((await store.get(a, ids[a]?.target ?? ''))?.backlinks).toEqual([
    { id: ids[a]?.source ?? '', title: 'Src' },
  ])
  expect((await store.get(b, ids[b]?.target ?? ''))?.backlinks).toEqual([])
  expect(await store.rekeyLinks(a)).toBe(0)
})
