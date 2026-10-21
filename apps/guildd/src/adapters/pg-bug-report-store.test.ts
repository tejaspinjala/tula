import { afterAll, expect, test } from 'bun:test'
import postgres from 'postgres'
import { createDb } from '../db/client'
import { bugReportStoreContract } from '../ports/bug-report-store.contract'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { MemoryClock } from './memory-clock'
import { MemoryKeyProvider } from './memory-key-provider'
import { PgBugReportStore } from './pg-bug-report-store'
import { PgQuestQueue } from './pg-quest-queue'

const db = createDb(testDbUrl('app'))
const owner = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
afterAll(async () => {
  await db.close()
  await owner.end()
})

function build() {
  const keys = new MemoryKeyProvider()
  const quests = new PgQuestQueue(db, keys, new MemoryClock(new Date()))
  return { keys, quests, store: new PgBugReportStore(db, keys, quests) }
}

bugReportStoreContract('postgres', async () => {
  const { quests, store } = build()
  return { store, quests, newGuild: () => foundTestGuild(db, { name: 'Bugs', goal: 'g' }) }
})

const H = 'a'.repeat(64)
const filing = (tag: string) => ({
  owningHall: 'heralds',
  title: 'SECRET-TITLE',
  reproduction: { steps: `SECRET-STEPS-${tag}`, expected: 'e', actual: 'a' },
  evidence: [H],
  filer: { kind: 'guild_master' as const },
  fixQuest: {
    jobKey: `fix:${crypto.randomUUID()}`,
    templateId: 'fix-quest',
    hallId: 'heralds',
    rank: 'journeyman' as const,
    dataClass: 'internal' as const,
    title: 'Fix: x',
    ownerId: 'heralds-member-2',
    doneCondition: 'Fix it',
    roundLimit: 2,
    board: true,
  },
  at: new Date(),
})

test('filing and a duplicate append bug_report.filed and bug_report.duplicate with ids and hashes only', async () => {
  const guild = await foundTestGuild(db, { name: 'Bugs', goal: 'g' })
  const { store } = build()
  await store.file(guild, filing('one'))
  await store.file(guild, { ...filing('one'), fixQuest: filing('one').fixQuest })
  const events = await owner`
    select type, payload from events
    where guild_id = ${guild} and type like 'bug_report.%' order by seq`
  expect(events.map((e) => e.type)).toEqual(['bug_report.filed', 'bug_report.duplicate'])
  expect(Object.keys(events[0]?.payload).sort()).toEqual([
    'bugReportId',
    'fixQuestId',
    'owningHall',
    'reproductionHash',
  ])
  expect(JSON.stringify(events)).not.toContain('SECRET')
})

test('the Fix Quest and the report commit together: a failing post leaves no report', async () => {
  const guild = await foundTestGuild(db, { name: 'Bugs', goal: 'g' })
  const { store } = build()
  const bad = filing('atomic')
  const failed = await store
    .file(guild, { ...bad, fixQuest: { ...bad.fixQuest, blockedBy: [crypto.randomUUID()] } })
    .then(
      () => 'ok',
      (e: Error) => e.message
    )
  expect(failed).not.toBe('ok')
  expect(await store.list(guild, { hallId: 'heralds', limit: 10 })).toEqual({
    reports: [],
    next: null,
  })
})

test('closeFixed marks the open report fixed with the Handoff hash, once, and ignores other guilds and unknown Quests', async () => {
  const guild = await foundTestGuild(db, { name: 'Bugs', goal: 'g' })
  const other = await foundTestGuild(db, { name: 'BugsOther', goal: 'g' })
  const { store } = build()
  const filed = await store.file(guild, filing('fix'))
  if (!filed.ok || !filed.fixQuest) {
    throw new Error('filing failed')
  }
  const at = new Date('2030-01-01T00:00:00.000Z')
  await store.closeFixed(other, filed.fixQuest.id, H, at)
  await store.closeFixed(guild, crypto.randomUUID(), H, at)
  expect(await store.get(guild, filed.report.id)).toMatchObject({ status: 'open' })
  await store.closeFixed(guild, filed.fixQuest.id, H, at)
  await store.closeFixed(guild, filed.fixQuest.id, 'e'.repeat(64), at)
  expect(await store.get(guild, filed.report.id)).toMatchObject({
    status: 'fixed',
    fixHandoffHash: H,
    fixedAt: at.toISOString(),
  })
  const events = await owner`
    select payload from events where guild_id = ${guild} and type = 'bug_report.fixed'`
  expect(events).toHaveLength(1)
  expect(Object.keys(events[0]?.payload).sort()).toEqual([
    'bugReportId',
    'fixQuestId',
    'handoffHash',
    'owningHall',
  ])
})

test('a cross-guild read sees no row, a forged insert is refused, and no update or delete is granted', async () => {
  const a = await foundTestGuild(db, { name: 'BugsA', goal: 'g' })
  const b = await foundTestGuild(db, { name: 'BugsB', goal: 'g' })
  const { store } = build()
  const filed = await store.file(a, filing('iso'))
  expect(await store.get(b, filed.ok ? filed.report.id : '')).toBeNull()
  const forged = await db
    .withGuild(
      b,
      (tx) => tx`
        insert into bug_reports (guild_id, owning_hall, title, reproduction, reproduction_hash,
          evidence, filed_by, status, created_at)
        values (${a}, 'heralds', 't', '{}', ${H}, '[]', 'guild_master', 'open', now())`
    )
    .then(
      () => 'ok',
      (e: Error) => e.message
    )
  expect(forged).toContain('row-level security')
  const deleted = await db
    .withGuild(a, (tx) => tx`delete from bug_reports`)
    .then(
      () => 'ok',
      (e: Error) => e.message
    )
  expect(deleted).toContain('permission denied')
})
