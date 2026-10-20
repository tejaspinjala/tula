import { afterAll, expect, test } from 'bun:test'
import postgres from 'postgres'
import { createDb } from '../db/client'
import { noteStoreContract } from '../ports/note-store.contract'
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
  newGuild: () => db.foundGuild({ name: 'Archive', goal: 'g' }),
}))

test('note writes append note.added and note.edited events, never the body', async () => {
  const guild = await db.foundGuild({ name: 'Archive', goal: 'g' })
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
