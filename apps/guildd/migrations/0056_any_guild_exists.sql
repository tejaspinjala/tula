-- The founding lock (FOUNDING_MODE=once) must know whether ANY guild exists before founding one,
-- and forced RLS on `guilds` hides every row from a caller with no tenant. This owner-side function
-- (security definer, so it runs with the migrator's BYPASSRLS) answers that single question and
-- returns a boolean only: no id, name or count crosses the tenant boundary. The search path is
-- pinned and every name is schema-qualified; only the app role may execute it.
create function any_guild_exists() returns boolean
  language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select exists (select 1 from public.guilds)
$$;

revoke all on function any_guild_exists() from public;
grant execute on function any_guild_exists() to guildhall_app;
