import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import postgres from 'postgres'
import { FileKeyProvider } from '../apps/guildd/src/adapters/file-key-provider'
import { MemoryCheckpointAnchor } from '../apps/guildd/src/adapters/memory-checkpoint-anchor'
import { S3ObjectStore } from '../apps/guildd/src/adapters/s3-object-store'
import { SystemClock } from '../apps/guildd/src/adapters/system-clock'
import { signCheckpoint, verifyChain, verifyFrom } from '../apps/guildd/src/audit-chain'
import { createDb } from '../apps/guildd/src/db/client'
import { migrate, provisionAppRole } from '../apps/guildd/src/db/migrate'
import { appendEvent, headSeq } from '../apps/guildd/src/events'
import { hashBytes } from '../apps/guildd/src/ports/object-store'
import { hashProposal } from '../apps/guildd/src/ports/seal-store'
import { TEST_APP_PASSWORD } from '../apps/guildd/src/testing/test-db'
import { backup, backupKey, removeBucket, restore, restoreKey, type Target } from './backup-restore'

// The restore drill (#33): seed a guild, back up, restore into a scratch database and bucket,
// compare, then drop everything. Needs the compose stack (Postgres and MinIO).
const adminUrl = new URL(
  process.env.DATABASE_URL ?? 'postgres://guildhall:guildhall@localhost:5432/guildhall'
)
const endpoint = process.env.OBJECT_STORE_ENDPOINT ?? 'http://localhost:9000'
const accessKeyId = process.env.OBJECT_STORE_ACCESS_KEY ?? 'guildhall'
const secretAccessKey = process.env.OBJECT_STORE_SECRET_KEY ?? 'guildhall-dev-secret'

const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10)
const source: Target = { database: `guildhall_drill_src_${suffix}`, bucket: `drill-src-${suffix}` }
const scratch: Target = { database: `guildhall_drill_dst_${suffix}`, bucket: `drill-dst-${suffix}` }

function urlFor(database: string, role: 'owner' | 'app'): string {
  const url = new URL(adminUrl)
  url.pathname = `/${database}`
  if (role === 'app') {
    url.username = 'guildhall_app'
    url.password = TEST_APP_PASSWORD
  }
  return url.toString()
}

const connection = { databaseUrl: adminUrl.toString(), endpoint, accessKeyId, secretAccessKey }
const work = await mkdtemp(join(tmpdir(), 'guildhall-drill-'))

afterAll(async () => {
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} })
  try {
    for (const t of [source, scratch]) {
      await admin.unsafe(`drop database if exists "${t.database}" with (force)`)
    }
  } finally {
    await admin.end()
  }
  for (const t of [source, scratch]) {
    await removeBucket({ endpoint, accessKeyId, secretAccessKey, bucket: t.bucket })
  }
  await rm(work, { recursive: true, force: true })
})

const SEAL_STATUSES = [
  'requested',
  'approved',
  'denied',
  'expired',
  'reserved',
  'consumed',
  'released',
] as const

describe('backup and restore drill', () => {
  test('a restored scratch stack matches the backed-up guild', async () => {
    // Seed: a migrated source database, a guild with events and an artifact.
    const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} })
    await admin.unsafe(`create database "${source.database}"`)
    await admin.end()
    const owner = postgres(urlFor(source.database, 'owner'), { max: 1, onnotice: () => {} })
    await migrate(owner)
    await provisionAppRole(owner, TEST_APP_PASSWORD)
    await owner.end()

    const keyPath = join(work, 'keys-live', 'master.key')
    const keys = await FileKeyProvider.open(keyPath)
    const witness = {
      anchor: new MemoryCheckpointAnchor(),
      identity: { verifyCheckpointAssertion: async () => true },
      clock: new SystemClock(),
    }
    const store = new S3ObjectStore({
      endpoint,
      bucket: source.bucket,
      accessKeyId,
      secretAccessKey,
    })
    await store.ensureBucket()
    const db = createDb(urlFor(source.database, 'app'))
    const guild = await db.foundGuildChained({ name: 'Drill Guild', goal: 'survive' }, keys)
    const content = `artifact ${suffix}`
    const bytes = new TextEncoder().encode(content)
    const hash = await store.put(guild, bytes)
    const before = await db.withGuild(guild, async (tx) => {
      await tx`insert into artifacts (guild_id, hash, size, class) values (${guild}, ${hash}, ${bytes.byteLength}, 'note')`
      await appendEvent(tx, keys, 'artifact.stored', {
        hash,
        class: 'note',
        size: bytes.byteLength,
      })
      await appendEvent(tx, keys, 'quest.noted', { note: 'known note' })
      // One Seal in every status, a Quest and a signed checkpoint (with a stub passkey assertion).
      for (const status of SEAL_STATUSES) {
        const text = `proposal ${status}`
        await tx`insert into seals (guild_id, quest_id, requested_by, kind, text, evidence, action_hash,
            status, requested_at, expires_at, reservation_token_hash)
          values (${guild}, ${crypto.randomUUID()}, 'herald-1', 'post', ${text}, 'e',
            ${await hashProposal(text)}, ${status}, now(), now() + interval '1 hour', ${status === 'reserved' ? 'c'.repeat(64) : null})`
      }
      await tx`insert into quests (guild_id, job_key, template_id, hall_id, rank, data_class, title,
          owner_id, done_condition, state, round_limit, max_attempts, not_before)
        values (${guild}, 'drill', 'herald-brief', 'heralds', 'journeyman', 'internal', 't',
          'heralds-member-2', 'c', 'queued', 1, 3, now())`
      const reached = (await verifyFrom(tx, keys, witness)).position
      const stub = {
        credentialId: 'stub',
        authenticatorData: 'stub',
        clientDataJSON: 'stub',
        signature: 'stub',
      }
      const signed = await signCheckpoint(tx, keys, witness, { expect: reached, assertion: stub })
      expect(signed.ok).toBe(true)
      return { events: await headSeq(tx), verdict: await verifyChain(tx, keys, witness) }
    })
    expect(before.verdict.intact).toBe(true)
    await db.close()

    // Back up: database and objects go to one directory, the master key to another.
    const dataDir = join(work, 'backup-data')
    const keyDir = join(work, 'backup-keys')
    await backup({ ...connection, ...source, outDir: dataDir })
    await backupKey(keyPath, keyDir)
    expect((await readdir(dataDir)).sort()).toEqual(['guildhall.dump', 'manifest.json', 'objects'])
    expect(await readdir(keyDir)).toEqual(['master.key'])
    expect((await stat(join(keyDir, 'master.key'))).mode & 0o077).toBe(0)

    // Restore into the scratch database and bucket, with the key from its separate backup.
    await restore({ ...connection, ...scratch, inDir: dataDir })
    await mkdir(join(work, 'keys-restored'), { recursive: true, mode: 0o700 })
    const restoredKeyPath = join(work, 'keys-restored', 'master.key')
    await restoreKey(keyDir, restoredKeyPath)

    const restoredKeys = await FileKeyProvider.open(restoredKeyPath, { create: false })
    const restoredStore = new S3ObjectStore({
      endpoint,
      bucket: scratch.bucket,
      accessKeyId,
      secretAccessKey,
    })
    const restoredDb = createDb(urlFor(scratch.database, 'app'))
    try {
      const after = await restoredDb.withGuild(guild, async (tx) => ({
        events: await headSeq(tx),
        verdict: await verifyChain(tx, restoredKeys, witness),
        notes: await tx`select payload from events where type = 'quest.noted'`,
      }))
      expect(after.events).toBe(before.events)
      expect(after.verdict).toEqual(before.verdict)
      expect(after.notes.map((n) => n.payload)).toEqual([{ note: 'known note' }])
      const counts = await restoredDb.withGuild(guild, async (tx) => ({
        seals: await tx`select status from seals order by status`,
        quests: await tx`select 1 from quests`,
        checkpoints: await tx`select 1 from audit_checkpoints`,
      }))
      expect(counts.seals.map((r) => r.status)).toEqual([...SEAL_STATUSES].sort())
      expect(counts.quests).toHaveLength(1)
      expect(counts.checkpoints).toHaveLength(1)
      // The restore carried the Seal guard trigger: a consumed Seal cannot be moved again.
      await expect(
        restoredDb.withGuild(
          guild,
          (tx) => tx`update seals set status = 'requested' where status = 'consumed'`
        )
      ).rejects.toThrow('seals: ')
      const restored = await restoredStore.get(guild, hash)
      expect(restored).not.toBeNull()
      expect(restored ? hashBytes(restored) : null).toBe(hash)
    } finally {
      await restoredDb.close()
    }
  }, 120_000)
})
