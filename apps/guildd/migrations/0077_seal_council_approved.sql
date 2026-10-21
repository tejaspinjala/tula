-- Council-approved Seals (#150, ADR-0011): while the Guild Master is away, the Council of Elders may
-- settle a routine Proposal's Seal request itself. The Seal ends in a new terminal status,
-- `council_approved`, which names the Council session (council_session_id) and never a Guild
-- Master (decided_by stays null). requested -> council_approved is the only way the column is set,
-- and like every decision field it is written once. Adds a new migration: 0020 is on develop.

alter table seals drop constraint seals_status_check;
alter table seals add constraint seals_status_check
  check (status in ('requested', 'approved', 'denied', 'expired', 'reserved', 'consumed', 'released', 'council_approved'));

alter table seals add column council_session_id uuid;
alter table seals add constraint seals_council_session
  check ((status = 'council_approved') = (council_session_id is not null));
-- The session a Council approval names must exist in the same guild.
alter table seals add constraint seals_council_session_exists
  foreign key (guild_id, council_session_id) references council_sessions (guild_id, session_id);

create or replace function seals_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.guild_id is distinct from old.guild_id
     or new.seal_id is distinct from old.seal_id
     or new.quest_id is distinct from old.quest_id
     or new.round is distinct from old.round
     or new.requested_by is distinct from old.requested_by
     or new.kind is distinct from old.kind
     or new.text is distinct from old.text
     or new.evidence is distinct from old.evidence
     or new.action_hash is distinct from old.action_hash
     or new.requested_at is distinct from old.requested_at
     or new.expires_at is distinct from old.expires_at then
    raise exception 'seals: the request is immutable' using errcode = 'check_violation';
  end if;

  if not (
       (old.status = 'requested' and new.status in ('approved', 'denied', 'expired', 'council_approved'))
    or (old.status in ('approved', 'released') and new.status in ('reserved', 'consumed', 'expired'))
    or (old.status = 'reserved' and new.status in ('consumed', 'released'))
  ) then
    raise exception 'seals: % -> % is not allowed', old.status, new.status
      using errcode = 'check_violation';
  end if;

  if old.status = 'requested' and new.status in ('approved', 'denied', 'council_approved') then
    if new.decided_at is null then
      raise exception 'seals: a decision needs decided_at' using errcode = 'check_violation';
    end if;
    if new.status = 'council_approved' and new.decided_by is not null then
      raise exception 'seals: a Council approval is never a member decision'
        using errcode = 'check_violation';
    end if;
  elsif new.decided_at is distinct from old.decided_at
     or new.decision_note is distinct from old.decision_note
     or new.decided_by is distinct from old.decided_by
     or new.council_session_id is distinct from old.council_session_id then
    raise exception 'seals: a decision is made once' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- The coded reason `council_approved` joins FailReason (a Quest finished by the Council records it
-- as its last error), so release_all_leases accepts the full list again. Otherwise unchanged from 0051.
create or replace function release_all_leases(p_reason text) returns integer
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_count integer;
begin
  if p_reason is null or p_reason <> all (array['timeout', 'provider_error', 'routing_blocked', 'worker_crash', 'sandbox_unavailable', 'seal_rejected', 'no_revision', 'requester_reserved', 'blocker_dead', 'hall_locked', 'hall_not_found', 'private_provider_unavailable', 'council_approved', 'unknown']) then
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
