-- Bar the Gates review fixes.

-- A global bar revokes every guild's run tokens in ONE statement instead of a per-guild loop. This
-- owner-side function (security definer, so it runs with the migrator's BYPASSRLS, which forced
-- RLS on `model_runs` otherwise forbids without a tenant) updates run states and nothing else,
-- touches no content, and returns only a count. The search path is pinned and every name is
-- schema-qualified; only the app role may execute it. The per-guild revoke stays a tenant update.
create function revoke_all_run_tokens() returns integer
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_count integer;
begin
  update public.model_runs set state = 'revoked', revoke_reason = 'manual'
  where state <> 'revoked' or revoke_reason = 'hall_paused';
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

revoke all on function revoke_all_run_tokens() from public;
grant execute on function revoke_all_run_tokens() to guildhall_app;

-- list_guild_ids (0043) again, with the table schema-qualified and the search path pinned.
-- It enumerates opaque guild ids across tenants (see .claude/rules/tenancy.md).
create or replace function list_guild_ids(p_after uuid, p_limit integer) returns setof uuid
  language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select guild_id from public.guilds
  where p_after is null or guild_id > p_after
  order by guild_id limit least(greatest(p_limit, 1), 1000)
$$;

revoke all on function list_guild_ids(uuid, integer) from public;
grant execute on function list_guild_ids(uuid, integer) to guildhall_app;
