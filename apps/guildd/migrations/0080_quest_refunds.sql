-- Refunded claims (a wait, a Bar the Gates release, a park) are counted in quests.refunds, so the
-- loop Tripwire counts attempts minus refunds: a Quest waiting for a provider is not a loop. A
-- resume forgives the rest (refunds = attempts). release_all_leases now raises refunds with the
-- budget refund. Body, pinned search_path, reason list and grant are otherwise unchanged from 0079.
alter table quests add column refunds integer not null default 0 check (refunds >= 0);
grant update (refunds) on quests to guildhall_app;

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
    max_attempts = max_attempts + 1, refunds = refunds + 1
  where state = 'active';
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

revoke all on function release_all_leases(text) from public;
grant execute on function release_all_leases(text) to guildhall_app;
