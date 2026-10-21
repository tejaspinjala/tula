import { afterAll, expect, test } from 'bun:test'
import postgres from 'postgres'
import { createDb } from '../db/client'
import { dossierStoreContract } from '../ports/dossier-store.contract'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { MemoryKeyProvider } from './memory-key-provider'
import { PgDossierStore } from './pg-dossier-store'

const db = createDb(testDbUrl('app'))
const owner = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
afterAll(async () => {
  await db.close()
  await owner.end()
})

dossierStoreContract('postgres', async () => ({
  store: new PgDossierStore(db, new MemoryKeyProvider()),
  newGuild: () => foundTestGuild(db, { name: 'Dossiers', goal: 'g' }),
}))

const H = 'a'.repeat(64)
const body = {
  questId: crypto.randomUUID(),
  hallId: 'heralds',
  goal: 'SECRET-GOAL',
  doneCondition: 'd',
  met: true,
  verdict: null,
  seal: null,
  handoffHash: H,
  artifacts: [],
}
const input = {
  subjectQuestId: body.questId,
  subjectHallId: 'heralds',
  requester: { kind: 'guild_master' as const },
  body,
  hash: H,
  verified: true,
  failedChecks: [],
  at: new Date(),
}

test('a create appends dossier.created with ids and hashes only, never the body', async () => {
  const guild = await foundTestGuild(db, { name: 'Dossiers', goal: 'g' })
  const store = new PgDossierStore(db, new MemoryKeyProvider())
  const made = await store.create(guild, input)
  const events = await owner`
    select payload from events where guild_id = ${guild} and type = 'dossier.created'`
  expect(events).toHaveLength(1)
  expect(Object.keys(events[0]?.payload).sort()).toEqual([
    'dossierId',
    'hash',
    'requesterHall',
    'subjectHall',
    'subjectQuestId',
    'verified',
  ])
  expect(events[0]?.payload.dossierId).toBe(made.ok ? made.dossier.id : '')
  expect(JSON.stringify(events)).not.toContain('SECRET-GOAL')
})

test('a cross-guild read through the app role sees no row of another guild, a forged insert is refused, and no update or delete is granted', async () => {
  const a = await foundTestGuild(db, { name: 'DossiersA', goal: 'g' })
  const b = await foundTestGuild(db, { name: 'DossiersB', goal: 'g' })
  const store = new PgDossierStore(db, new MemoryKeyProvider())
  const made = await store.create(a, input)
  expect(await store.get(b, made.ok ? made.dossier.id : '')).toBeNull()
  expect(await store.list(b, { hallId: 'heralds', limit: 10 })).toEqual({
    dossiers: [],
    next: null,
  })
  const forged = await db
    .withGuild(
      b,
      (tx) => tx`
        insert into dossiers (guild_id, subject_quest_id, subject_hall_id, requested_by, body,
          dossier_hash, verified, failed_checks, created_at)
        values (${a}, ${crypto.randomUUID()}, 'heralds', 'guild_master', '{}', ${H}, true, '[]', now())`
    )
    .then(
      () => 'ok',
      (e: Error) => e.message
    )
  expect(forged).toContain('row-level security')
  const tampered = await db
    .withGuild(a, (tx) => tx`update dossiers set verified = false`)
    .then(
      () => 'ok',
      (e: Error) => e.message
    )
  expect(tampered).toContain('permission denied')
})
