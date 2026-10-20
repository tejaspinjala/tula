import { afterAll, expect, test } from 'bun:test'
import postgres from 'postgres'
import { createDb } from '../db/client'
import { suggestionStoreContract } from '../ports/suggestion-store.contract'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { MemoryClock } from './memory-clock'
import { MemoryKeyProvider } from './memory-key-provider'
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
  store: new PgSuggestionStore(db, new MemoryKeyProvider(), clock),
  newGuild,
}))

test('the database refuses a source id taken twice and a status outside the three states', async () => {
  const guild = await newGuild()
  const store = new PgSuggestionStore(db, new MemoryKeyProvider(), clock)
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

test('decisions append chained events with the suggestion and source ids only', async () => {
  const guild = await newGuild()
  const keys = new MemoryKeyProvider()
  const store = new PgSuggestionStore(db, keys, clock)
  const item = (n: number) => ({
    sourceId: `pr:o/r#${n}`,
    repo: 'o/r',
    kind: 'pr' as const,
    title: 'secret-title',
    body: 'secret-body',
    url: 'https://github.com/o/r/pull/1',
  })
  await store.addMany(guild, [item(1), item(2)])
  const [a, b] = (await store.list(guild, { limit: 10 })).suggestions
  await store.decide(guild, a?.id ?? '', 'accepted')
  await store.decide(guild, b?.id ?? '', 'dismissed')
  await store.decide(guild, b?.id ?? '', 'dismissed')
  const events = await owner`
    select type, payload from events where guild_id = ${guild} and type ~ '^learning\\.' order by seq`
  expect(events.map((e) => e.type)).toEqual(['learning.accepted', 'learning.dismissed'])
  const sourceHash = await keys.mac(
    guild,
    'learning-source',
    new TextEncoder().encode(a?.sourceId ?? '')
  )
  expect(events[0]?.payload).toEqual({ suggestionId: a?.id, sourceHash })
  const json = JSON.stringify(events)
  expect(json).not.toContain('o/r')
  expect(json).not.toContain('pr:')
  expect(json).not.toContain('secret-title')
  expect(json).not.toContain('secret-body')
})
