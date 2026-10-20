import { describe, expect, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { migrate, migrationsDir } from '../src/db/migrate'
import { withScratchSchema } from '../src/testing/test-db'

// Derived from the directory, so adding a migration never means editing this test.
const onDisk = (await readdir(new URL('../migrations/', import.meta.url)))
  .filter((name) => name.endsWith('.sql'))
  .sort()

describe('migrate', () => {
  test('applies migrations to a pristine schema, then is a no-op on re-run', async () => {
    await withScratchSchema(async (sql, schema) => {
      const first = await migrate(sql, migrationsDir, { schema })
      expect(first.applied).toEqual(onDisk)

      const second = await migrate(sql, migrationsDir, { schema })
      expect(second.applied).toEqual([])

      const rows = await sql.unsafe(`select name from ${schema}.schema_migrations order by name`)
      expect(rows.map((r) => r.name)).toEqual(onDisk)
    })
  })
})
