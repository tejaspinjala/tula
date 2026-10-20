-- Seals: the Guild Master's single-use, expiring approval, bound to the hash of the exact
-- Proposal. States: requested -> approved | denied | expired; approved -> reserved ->
-- consumed | released; released -> reserved. A lapsed reservation is read as approved by code
-- (reserved -> reserved renews it). The decision is made once and never changes.

create table seals (
  guild_id uuid not null references guilds (guild_id),
  seal_id uuid not null default gen_random_uuid(),
  quest_id uuid not null,
  requested_by text not null check (length(requested_by) between 1 and 200),
  kind text not null check (length(kind) between 1 and 100),
  text text not null check (length(text) between 1 and 20000),
  evidence text not null check (length(evidence) <= 20000),
  action_hash text not null check (action_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'requested'
    check (status in ('requested', 'approved', 'denied', 'expired', 'reserved', 'consumed', 'released')),
  requested_at timestamptz not null,
  expires_at timestamptz not null,
  decided_at timestamptz,
  decision_note text check (length(decision_note) <= 2000),
  reserved_until timestamptz,
  consumed_at timestamptz,
  primary key (guild_id, seal_id),
  unique (guild_id, quest_id, action_hash)
);

alter table seals enable row level security;
alter table seals force row level security;
create policy seals_tenant on seals
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select, insert, update on seals to guildhall_app;

-- The request is immutable; only status moves, along the allowed edges, and a decision (when,
-- note) is set exactly with the requested -> approved | denied move and never again. Not a
-- security-definer function: it runs with the caller's rights and only inspects the row.
create function seals_guard() returns trigger
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

  if not (
       (old.status = 'requested' and new.status in ('approved', 'denied', 'expired'))
    or (old.status in ('approved', 'released') and new.status = 'reserved')
    or (old.status = 'reserved' and new.status in ('reserved', 'consumed', 'released'))
    or (old.status = 'approved' and new.status = 'consumed')
    or (old.status = 'released' and new.status = 'consumed')
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

revoke all on function seals_guard() from public;

create trigger seals_guard
  before update on seals
  for each row execute function seals_guard();
