-- The paper Treasury (#28). Paper only: every ledger entry is `mode = 'paper'` and no payment
-- provider exists anywhere in the system. Money is integer cents (bigint), never a float.
--
-- treasury_spends: a spend request against the operating envelope. Funds are held (reserved) by a
-- ledger entry while the request is `reserved`; it then settles (the unspent part returns) or is
-- released. A request over the Treasurer limit or the daily cap waits as `pending_approval` for
-- the Guild Master. Only status, settled cents, approver and escalation ever change.
--
-- treasury_ledger: append-only, hash-chained per guild. Each entry is a signed delta on one
-- bucket (operating, reserve, profit); a bucket's balance is the sum of its entries. `hash` covers
-- the entry and the previous entry's hash, so altering any entry breaks the chain from there.

create table treasury_spends (
  guild_id uuid not null references guilds (guild_id),
  spend_id uuid not null,
  seq bigint generated always as identity,
  client_key text not null check (length(client_key) between 1 and 200),
  amount_cents bigint not null check (amount_cents > 0),
  settled_cents bigint check (settled_cents >= 0 and settled_cents <= amount_cents),
  purpose text not null check (length(purpose) between 1 and 2000),
  requested_by text not null check (length(requested_by) between 1 and 200),
  status text not null
    check (status in ('pending_approval', 'reserved', 'settled', 'released', 'denied')),
  escalation text check (escalation in ('over_treasurer_limit', 'daily_cap')),
  approved_by text check (approved_by in ('treasurer', 'guild_master')),
  created_at timestamptz not null,
  primary key (guild_id, spend_id),
  unique (guild_id, client_key),
  unique (guild_id, seq),
  check (status <> 'pending_approval' or escalation is not null),
  check ((status = 'settled') = (settled_cents is not null))
);

create table treasury_ledger (
  guild_id uuid not null references guilds (guild_id),
  seq bigint not null check (seq > 0),
  entry_id uuid not null,
  kind text not null
    check (kind in ('seed', 'revenue', 'reserve_release', 'spend_reserve', 'spend_settle', 'spend_release')),
  bucket text not null check (bucket in ('operating', 'reserve', 'profit')),
  amount_cents bigint not null check (amount_cents <> 0),
  mode text not null default 'paper' check (mode = 'paper'),
  spend_id uuid,
  idem_key text check (length(idem_key) between 1 and 250),
  evidence text check (length(evidence) <= 2000),
  day date not null,
  created_at timestamptz not null,
  prev_hash text not null check (prev_hash ~ '^[0-9a-f]{64}$'),
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  primary key (guild_id, seq),
  unique (guild_id, entry_id),
  unique (guild_id, idem_key, bucket),
  foreign key (guild_id, spend_id) references treasury_spends (guild_id, spend_id),
  -- Revenue without evidence is rejected here too, not only in code.
  check (kind <> 'revenue' or coalesce(length(btrim(evidence)), 0) > 0)
);
create index treasury_ledger_by_day on treasury_ledger (guild_id, day);

alter table treasury_spends enable row level security;
alter table treasury_spends force row level security;
create policy treasury_spends_tenant on treasury_spends
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

alter table treasury_ledger enable row level security;
alter table treasury_ledger force row level security;
create policy treasury_ledger_tenant on treasury_ledger
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select, insert, update on treasury_spends to guildhall_app;
grant select, insert on treasury_ledger to guildhall_app;

-- A spend request's terms are immutable; only its state moves, along the allowed edges. Not
-- security definer: it runs with the caller's rights and only inspects the row.
create function treasury_spends_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.guild_id is distinct from old.guild_id
     or new.spend_id is distinct from old.spend_id
     or new.seq is distinct from old.seq
     or new.client_key is distinct from old.client_key
     or new.amount_cents is distinct from old.amount_cents
     or new.purpose is distinct from old.purpose
     or new.requested_by is distinct from old.requested_by
     or new.created_at is distinct from old.created_at then
    raise exception 'treasury_spends: the request is immutable' using errcode = 'check_violation';
  end if;
  if not (
       (old.status = 'pending_approval' and new.status in ('reserved', 'denied'))
    or (old.status = 'reserved' and new.status in ('settled', 'released'))
  ) then
    raise exception 'treasury_spends: % -> % is not allowed', old.status, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function treasury_spends_guard() from public;

create trigger treasury_spends_guard
  before update on treasury_spends
  for each row execute function treasury_spends_guard();

-- The ledger is append-only for every role, the owner included: no update, delete or truncate.
create function treasury_ledger_append_only() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'treasury_ledger is append-only' using errcode = 'check_violation';
end;
$$;

revoke all on function treasury_ledger_append_only() from public;

create trigger treasury_ledger_append_only
  before update or delete on treasury_ledger
  for each row execute function treasury_ledger_append_only();

create trigger treasury_ledger_no_truncate
  before truncate on treasury_ledger
  for each statement execute function treasury_ledger_append_only();
