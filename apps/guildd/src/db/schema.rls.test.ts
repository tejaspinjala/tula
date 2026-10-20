import { afterAll, expect, test } from 'bun:test'
import { createHarness } from '../testing/harness'

const harness = await createHarness()
afterAll(() => harness.close())

/** Tables in the app schema that are not tenant data. */
const NOT_TENANT = ['schema_migrations']

test('every table in the app schema has guild_id, ENABLE + FORCE RLS and at least one policy', async () => {
  const rows = await harness.owner`
    select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
      (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies,
      exists (
        select 1 from pg_attribute a
        where a.attrelid = c.oid and a.attname = 'guild_id' and not a.attisdropped
      ) as has_guild_id
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname <> all(${NOT_TENANT})
    order by c.relname`
  const offenders = rows.filter((r) => !(r.rls && r.forced && r.policies >= 1 && r.has_guild_id))
  expect(rows.length).toBeGreaterThan(0)
  expect(offenders.map((r) => r.name)).toEqual([])
})
