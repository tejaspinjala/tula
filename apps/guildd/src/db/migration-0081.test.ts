import { expect, test } from 'bun:test'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Sql } from 'postgres'
import { withScratchSchema } from '../testing/test-db'
import { migrate, migrationsDir } from './migrate'

const MIGRATION = '0081_rite_drafts.sql'

/** A directory holding only the migrations before 0081, so a DB can be seeded at 0080. */
async function dirBefore0081(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'migrations-0080-'))
  for (const name of await readdir(migrationsDir)) {
    if (name.endsWith('.sql') && name < MIGRATION) {
      await copyFile(join(migrationsDir, name), join(dir, name))
    }
  }
  return dir
}

/** A guild with one Rite whose versions 1 and 2 are both `active` (the pre-0081 shape). */
async function seedTwoActive(sql: Sql, schema: string, second = 'active'): Promise<string> {
  const id = crypto.randomUUID()
  await sql.begin(async (tx) => {
    await tx`select set_config('search_path', quote_ident(${schema}), true)`
    await tx`select set_config('app.guild_id', ${id}, true)`
    await tx`insert into guilds (guild_id, name, goal) values (${id}, 'Old', 'g')`
    for (const version of [1, 2]) {
      await tx`insert into workflow_versions
        (guild_id, workflow_id, version, name, graph, classification, status, created_at)
        values (${id}, 'wf', ${version}, 'W', '{}'::jsonb, 'internal', ${version === 1 ? 'active' : second}, now())`
    }
  })
  return id
}

test('0081 supersedes every active version but the newest of a Rite', async () => {
  const before = await dirBefore0081()
  try {
    await withScratchSchema(async (sql, schema) => {
      await migrate(sql, before, { schema })
      const id = await seedTwoActive(sql, schema)
      await migrate(sql, migrationsDir, { schema })
      const rows = await sql.begin(async (tx) => {
        await tx`select set_config('search_path', quote_ident(${schema}), true)`
        await tx`select set_config('app.guild_id', ${id}, true)`
        return tx`select version, status from workflow_versions where guild_id = ${id} order by version`
      })
      expect(rows.map((r) => [r.version, r.status])).toEqual([
        [1, 'superseded'],
        [2, 'active'],
      ])
    })
  } finally {
    await rm(before, { recursive: true, force: true })
  }
})

test('0081 fails loudly, not silently, when the migrator is subject to row level security', async () => {
  const before = await dirBefore0081()
  const role = `mig_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
  try {
    await withScratchSchema(async (sql, schema) => {
      await migrate(sql, before, { schema })
      await seedTwoActive(sql, schema)
      await sql.unsafe(`create role ${role} nosuperuser nobypassrls`)
      try {
        await sql.unsafe(`grant usage, create on schema ${schema} to ${role}`)
        await sql.unsafe(`alter table ${schema}.workflow_versions owner to ${role}`)
        await sql.unsafe(`alter function ${schema}.workflow_version_frozen() owner to ${role}`)
        const attempt = sql.begin(async (tx) => {
          await tx`select set_config('search_path', quote_ident(${schema}), true)`
          await tx.unsafe(`set local role ${role}`)
          await tx.unsafe(await Bun.file(join(migrationsDir, MIGRATION)).text())
        })
        await expect(attempt).rejects.toThrow(/row-level security/)
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

test('0081 leaves a legacy pending version over an active one with no based_on, so a confirm stays stale', async () => {
  const before = await dirBefore0081()
  try {
    await withScratchSchema(async (sql, schema) => {
      await migrate(sql, before, { schema })
      const id = await seedTwoActive(sql, schema, 'pending')
      await migrate(sql, migrationsDir, { schema })
      const rows = await sql.begin(async (tx) => {
        await tx`select set_config('search_path', quote_ident(${schema}), true)`
        await tx`select set_config('app.guild_id', ${id}, true)`
        return tx`select version, status, based_on from workflow_versions where guild_id = ${id} order by version`
      })
      // v2 pending over the active v1 has no recorded base: the confirm rule (active must equal
      // based_on) refuses it as stale.
      expect(rows.map((r) => [r.version, r.status, r.based_on])).toEqual([
        [1, 'active', null],
        [2, 'pending', null],
      ])
    })
  } finally {
    await rm(before, { recursive: true, force: true })
  }
})
