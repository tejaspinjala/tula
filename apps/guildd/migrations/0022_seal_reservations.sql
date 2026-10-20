-- Seal reservations carry a holder token (stored only as a hash), so a stale holder can never act
-- on someone else's reservation. A lapsed reservation stays `reserved` (it reads as stale in
-- code) and cannot be reserved again; the holder may still consume or release it with its token,
-- or the Guild Master resolves it. Also: the sealed hash must be the SHA-256 of the sealed text,
-- and listing by status gets an index.

alter table seals add column reservation_token_hash text;

-- Not validated against rows written before this migration; every new or updated row is checked.
alter table seals add constraint seals_reservation_token
  check ((status = 'reserved') = (reservation_token_hash is not null)) not valid;

alter table seals add constraint seals_action_hash_binds_text
  check (action_hash = encode(sha256(convert_to(text, 'UTF8')), 'hex'));

create index seals_by_status on seals (guild_id, status, seal_id);

create or replace function seals_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.guild_id is distinct from old.guild_id
     or new.seal_id is distinct from old.seal_id
     or new.quest_id is distinct from old.quest_id
     or new.requested_by is distinct from old.requested_by
     or new.kind is distinct from old.kind
     or new.text is distinct from old.text
     or new.evidence is distinct from old.evidence
     or new.action_hash is distinct from old.action_hash
     or new.requested_at is distinct from old.requested_at
     or new.expires_at is distinct from old.expires_at then
    raise exception 'seals: the request is immutable' using errcode = 'check_violation';
  end if;

  -- A reservation is never renewed: reserved -> reserved is no longer an edge.
  if not (
       (old.status = 'requested' and new.status in ('approved', 'denied', 'expired'))
    or (old.status in ('approved', 'released') and new.status in ('reserved', 'consumed'))
    or (old.status = 'reserved' and new.status in ('consumed', 'released'))
  ) then
    raise exception 'seals: % -> % is not allowed', old.status, new.status
      using errcode = 'check_violation';
  end if;

  if old.status = 'requested' and new.status in ('approved', 'denied') then
    if new.decided_at is null then
      raise exception 'seals: a decision needs decided_at' using errcode = 'check_violation';
    end if;
  elsif new.decided_at is distinct from old.decided_at
     or new.decision_note is distinct from old.decision_note then
    raise exception 'seals: a decision is made once' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
