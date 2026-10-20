-- A global Bar the Gates frees every guild's active Quest leases in ONE statement instead of a
-- per-guild loop, so the bar's response time does not grow with the number of guilds. This
-- owner-side function (security definer, so it runs with the migrator's BYPASSRLS, which forced RLS
-- on `quests` otherwise forbids without a tenant) moves active Quests back to queued, deliverable
-- at once, with the coded reason; it touches no other column and returns only a count. Unlike the
-- per-guild release it takes no per-guild advisory lock: the single update locks the rows it
-- changes, and a claim racing it either wins the row first (and is released by the next run) or
-- sees the bar. The search path is pinned and every name is schema-qualified; only the app role may
-- execute it.
create function release_all_leases(p_reason text) returns integer
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_count integer;
begin
  update public.quests set state = 'queued', lease_expires_at = null,
    not_before = pg_catalog.now(), last_error = p_reason
  where state = 'active';
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

revoke all on function release_all_leases(text) from public;
grant execute on function release_all_leases(text) to guildhall_app;
