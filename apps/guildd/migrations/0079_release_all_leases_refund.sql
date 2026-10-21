-- Bar the Gates gives the claim back: release_all_leases (0050/0051/0077) returned active Quests to
-- queued but kept the attempt the claim had cost, so repeated bar-and-lift cycles drained the retry
-- budget. releaseLeases refunds it (max_attempts + 1, #165); the function now does the same. Body,
-- pinned search_path, reason list and grant are otherwise unchanged from 0077.
create or replace function release_all_leases(p_reason text) returns integer
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_count integer;
begin
  if p_reason is null or p_reason <> all (array['timeout', 'provider_error', 'routing_blocked', 'worker_crash', 'sandbox_unavailable', 'seal_rejected', 'no_revision', 'requester_reserved', 'blocker_dead', 'hall_locked', 'hall_not_found', 'private_provider_unavailable', 'council_approved', 'unknown']) then
    raise exception 'release_all_leases: unknown reason' using errcode = 'check_violation';
  end if;
  update public.quests set state = 'queued', lease_expires_at = null,
    not_before = pg_catalog.now(), last_error = p_reason,
    max_attempts = max_attempts + 1
  where state = 'active';
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

revoke all on function release_all_leases(text) from public;
grant execute on function release_all_leases(text) to guildhall_app;
