import { expect, test } from 'bun:test'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Sql } from 'postgres'
import { withScratchSchema } from '../testing/test-db'
import { migrate, migrationsDir } from './migrate'

const MIGRATION = '0034_session_principal.sql'

/** A directory holding only the migrations before 0034, so a DB can be seeded at 0033. */
async function dirBefore0034(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'migrations-0033-'))
  for (const name of await readdir(migrationsDir)) {
    if (name.endsWith('.sql') && name < MIGRATION) {
      await copyFile(join(migrationsDir, name), join(dir, name))
    }
  }
  return dir
}

async function seedGuild(sql: Sql, schema: string, withSession: boolean): Promise<string> {
  const id = crypto.randomUUID()
  await sql.begin(async (tx) => {
    await tx`select set_config('search_path', quote_ident(${schema}), true)`
    await tx`select set_config('app.guild_id', ${id}, true)`
    await tx`insert into guilds (guild_id, name, goal) values (${id}, 'Old', 'g')`
    if (withSession) {
      await tx`insert into identity_sessions (guild_id, session_id, token_hash, expires_at)
        values (${id}, ${crypto.randomUUID()}, 'th', now() + interval '1 hour')`
    }
  })
  return id
}

test('0034 gives an existing guild exactly one Guild Master and points its session at them', async () => {
  const before = await dirBefore0034()
  try {
    await withScratchSchema(async (sql, schema) => {
      await migrate(sql, before, { schema })
      const id = await seedGuild(sql, schema, true)
      await migrate(sql, migrationsDir, { schema })
      const rows = await sql.begin(async (tx) => {
        await tx`select set_config('search_path', quote_ident(${schema}), true)`
        await tx`select set_config('app.guild_id', ${id}, true)`
        const masters = await tx`select member_id, role from guild_members where guild_id = ${id}`
        const sessions = await tx`select member_id from identity_sessions where guild_id = ${id}`
        return { masters, sessions }
      })
      expect(rows.masters).toHaveLength(1)
      expect(rows.masters[0]?.role).toBe('guild_master')
      expect(rows.sessions[0]?.member_id).toBe(rows.masters[0]?.member_id)
    })
  } finally {
    await rm(before, { recursive: true, force: true })
  }
})

test('0034 fails loudly, not silently, when the migrator is subject to row level security', async () => {
  const before = await dirBefore0034()
  const role = `mig_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
  try {
    await withScratchSchema(async (sql, schema) => {
      await migrate(sql, before, { schema })
      await seedGuild(sql, schema, false)
      await sql.unsafe(`create role ${role} nosuperuser nobypassrls`)
      try {
        await sql.unsafe(`grant usage, create on schema ${schema} to ${role}`)
        await sql.unsafe(`alter table ${schema}.guilds owner to ${role}`)
        await sql.unsafe(`alter table ${schema}.identity_sessions owner to ${role}`)
        await sql.unsafe(`alter function ${schema}.found_guild(text, text) owner to ${role}`)
        const attempt = sql.begin(async (tx) => {
          await tx`select set_config('search_path', quote_ident(${schema}), true)`
          await tx.unsafe(`set local role ${role}`)
          await tx.unsafe(await Bun.file(join(migrationsDir, MIGRATION)).text())
        })
        await expect(attempt).rejects.toThrow()
      } finally {
        await sql.unsafe(`reassign owned by ${role} to current_user`)
        await sql.unsafe(`drop owned by ${role}`)
        await sql.unsafe(`drop role ${role}`)
      }
    })
  } finally {
    await rm(before, { recursive: true, force: true })
  }
})
