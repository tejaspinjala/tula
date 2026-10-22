import { expect, test } from 'bun:test'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Sql } from 'postgres'
import { withScratchSchema } from '../testing/test-db'
import { migrate, migrationsDir } from './migrate'

const MIGRATION = '0084_remove_orphan_guilds.sql'

/** A directory holding only the migrations before 0084, so a DB can be seeded at 0083. */
async function dirBefore0084(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'migrations-0083-'))
  for (const name of await readdir(migrationsDir)) {
    if (name.endsWith('.sql') && name < MIGRATION) {
      await copyFile(join(migrationsDir, name), join(dir, name))
    }
  }
  return dir
}

type Shape = 'orphan' | 'with-credential' | 'with-events' | 'fresh-orphan'

/** Inserts a guild straight into the scratch schema, with its founding events and an optional extra. */
async function seed(sql: Sql, schema: string, shape: Shape): Promise<string> {
  const id = crypto.randomUUID()
  await sql.begin(async (tx) => {
    await tx`select set_config('search_path', quote_ident(${schema}), true)`
    await tx`select set_config('app.guild_id', ${id}, true)`
    const created = shape === 'fresh-orphan' ? new Date() : new Date('2026-01-01T00:00:00Z')
    await tx`insert into guilds (guild_id, name, goal, created_at) values (${id}, ${shape}, 'g', ${created})`
    const types = ['guild.founded', 'identity.founding_token_issued', 'config.seeded']
    if (shape === 'with-events') {
      types.push('quest.posted')
    }
    await tx`insert into guild_event_counters (guild_id, last_seq) values (${id}, ${types.length})`
    for (const [i, type] of types.entries()) {
      await tx`insert into events (guild_id, seq, type) values (${id}, ${i + 1}, ${type})`
    }
    if (shape === 'with-credential') {
      await tx`insert into identity_credentials (guild_id, credential_id, public_key, counter, transports)
        values (${id}, ${`cred-${id}`}, 'k', 0, '{}')`
    }
  })
  return id
}

async function exists(sql: Sql, schema: string, id: string): Promise<boolean> {
  const rows = await sql.begin(async (tx) => {
    await tx`select set_config('search_path', quote_ident(${schema}), true)`
    return tx`select 1 from guilds where guild_id = ${id}`
  })
  return rows.length > 0
}

test('0084 removes an orphan guild and keeps one with a credential or other events', async () => {
  const before = await dirBefore0084()
  try {
    await withScratchSchema(async (sql, schema) => {
      await migrate(sql, before, { schema })
      const orphan = await seed(sql, schema, 'orphan')
      const credentialed = await seed(sql, schema, 'with-credential')
      const active = await seed(sql, schema, 'with-events')
      const fresh = await seed(sql, schema, 'fresh-orphan')
      await migrate(sql, migrationsDir, { schema })
      expect(await exists(sql, schema, orphan)).toBe(false)
      expect(await exists(sql, schema, credentialed)).toBe(true)
      expect(await exists(sql, schema, active)).toBe(true)
      // A guild younger than the grace period may still be mid-ceremony.
      expect(await exists(sql, schema, fresh)).toBe(true)
      const [left] = await sql.begin(async (tx) => {
        await tx`select set_config('search_path', quote_ident(${schema}), true)`
        return tx`select count(*)::int as n from events where guild_id = ${orphan}`
      })
      expect(left?.n).toBe(0)
      const [count] = await sql.begin(async (tx) => {
        await tx`select set_config('search_path', quote_ident(${schema}), true)`
        return tx`select count(*)::int as n from orphan_guild_ids(interval '0 seconds')`
      })
      expect(count?.n).toBe(1)
    })
  } finally {
    await rm(before, { recursive: true, force: true })
  }
})
