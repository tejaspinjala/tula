import type { Sql } from 'postgres'

/** Bookkeeping tables that hold no tenant data; each must be named in `.claude/rules/tenancy.md`. */
export const NOT_TENANT = ['schema_migrations', 'rate_limits', 'push_guilds']

/**
 * Scans every non-system schema and describes each tenancy violation: a table without ENABLE +
 * FORCE RLS or without a policy, a missing or nullable `guild_id`, a policy whose expressions do
 * not reference `app.guild_id`, or a table owned by the app role. Empty means compliant.
 * `schemas` narrows the scan (the shared test database may hold other tests' scratch schemas).
 */
export async function findTenancyViolations(
  sql: Sql,
  options: { schemas?: string[] } = {}
): Promise<string[]> {
  const only = options.schemas ?? null
  const tables = await sql`
    select c.oid, n.nspname || '.' || c.relname as name, c.relrowsecurity as rls,
      c.relforcerowsecurity as forced, r.rolname = 'guildhall_app' as app_owned,
      exists (
        select 1 from pg_attribute a
        where a.attrelid = c.oid and a.attname = 'guild_id' and a.attnotnull and not a.attisdropped
      ) as guild_id_ok
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_roles r on r.oid = c.relowner
    where c.relkind in ('r', 'p')
      and n.nspname <> 'information_schema' and n.nspname not like 'pg\\_%'
      and c.relname <> all(${NOT_TENANT})
      and (${only}::text[] is null or n.nspname = any(${only}::text[]))
    order by 2`
  const policies = await sql`
    select schemaname || '.' || tablename as name, policyname, qual, with_check
    from pg_policies`

  const violations: string[] = []
  for (const t of tables) {
    const mine = policies.filter((p) => p.name === t.name)
    if (!(t.rls && t.forced)) {
      violations.push(`${t.name}: row level security is not enabled and forced`)
    }
    if (mine.length === 0) {
      violations.push(`${t.name}: no policy`)
    }
    if (!t.guild_id_ok) {
      violations.push(`${t.name}: guild_id is missing or nullable`)
    }
    if (t.app_owned) {
      violations.push(`${t.name}: owned by the app role`)
    }
    for (const p of mine) {
      const exprs = [p.qual, p.with_check].filter((e): e is string => typeof e === 'string')
      if (exprs.length === 0 || !exprs.every((e) => e.includes('app.guild_id'))) {
        violations.push(`${t.name}: policy ${p.policyname} does not reference app.guild_id`)
      }
    }
  }
  return violations
}
