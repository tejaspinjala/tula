import { afterAll, expect, test } from 'bun:test'
import postgres from 'postgres'
import { createDb } from '../db/client'
import { suggestionStoreContract } from '../ports/suggestion-store.contract'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { MemoryClock } from './memory-clock'
import { PgSuggestionStore } from './pg-suggestion-store'

const db = createDb(testDbUrl('app'))
const owner = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
afterAll(async () => {
  await db.close()
  await owner.end()
})

const clock = new MemoryClock(new Date('2026-01-01T00:00:00.000Z'))
const newGuild = () => foundTestGuild(db, { name: 'Learning', goal: 'g' })

suggestionStoreContract('postgres', async () => ({
  store: new PgSuggestionStore(db, clock),
  newGuild,
}))

test('the database refuses a source id taken twice and a status outside the three states', async () => {
  const guild = await newGuild()
  const store = new PgSuggestionStore(db, clock)
  await store.addMany(guild, [
    {
      sourceId: 'pr:o/r#1',
      repo: 'o/r',
      kind: 'pr',
      title: 't',
      body: 'b',
      url: 'https://github.com/o/r/pull/1',
    },
  ])
  const refused = (sql: string) =>
    owner.unsafe(sql).then(
      () => 'ok',
      (e: Error) => e.message
    )
  expect(
    await refused(
      `insert into learning_suggestions (guild_id, source_id, repo, kind, title, body, url, created_at)
       values ('${guild}', 'pr:o/r#1', 'o/r', 'pr', 't', 'b', 'u', now())`
    )
  ).toContain('learning_suggestions_source')
  expect(
    await refused(`update learning_suggestions set status = 'weird' where guild_id = '${guild}'`)
  ).toContain('learning_suggestions_status_check')
})
