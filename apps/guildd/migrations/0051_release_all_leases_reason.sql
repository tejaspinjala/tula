-- release_all_leases (0050) stored whatever text its caller passed as the Quests' last error. Free
-- text must never reach a Quest (last_error is a coded FailReason), so the function now raises on
-- any reason outside the allowed FailReason values. Body, pinned search_path and grant are
-- otherwise unchanged from 0050. Keep the list in step with FAIL_REASONS in
-- apps/guildd/src/ports/quest-queue.ts.
create or replace function release_all_leases(p_reason text) returns integer
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_count integer;
begin
  if p_reason is null or p_reason <> all (array['timeout', 'provider_error', 'routing_blocked', 'worker_crash', 'sandbox_unavailable', 'seal_rejected', 'no_revision', 'requester_reserved', 'blocker_dead', 'hall_locked', 'hall_not_found', 'private_provider_unavailable', 'unknown']) then
    raise exception 'release_all_leases: unknown reason' using errcode = 'check_violation';
  end if;
  update public.quests set state = 'queued', lease_expires_at = null,
    not_before = pg_catalog.now(), last_error = p_reason
  where state = 'active';
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

revoke all on function release_all_leases(text) from public;
grant execute on function release_all_leases(text) to guildhall_app;
