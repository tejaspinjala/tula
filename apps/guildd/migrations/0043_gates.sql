-- Bar the Gates. A guild bar is a row in `guild_gates` (tenant table: forced RLS); lifting deletes
-- it. The `gates.barred` and `gates.lifted` events in the chain keep the history.

create table guild_gates (
  guild_id uuid not null references guilds (guild_id),
  bar_id uuid not null default gen_random_uuid(),
  barred_by uuid not null,
  barred_at timestamptz not null default now(),
  primary key (guild_id)
);

alter table guild_gates enable row level security;
alter table guild_gates force row level security;
create policy guild_gates_tenant on guild_gates
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select, insert, delete on guild_gates to guildhall_app;

-- Deliberately NOT a tenant table (like rate_limits, 0016, and push_guilds, 0041): the global bar
-- stops every guild, so it cannot belong to one. A single-row table holding an opaque bar id, the
-- opaque member id that barred and a timestamp; no guild data. Every guild's gate check reads it.
create table global_gate (
  singleton boolean primary key default true check (singleton),
  bar_id uuid not null default gen_random_uuid(),
  barred_by uuid not null,
  barred_at timestamptz not null default now()
);

grant select, insert, delete on global_gate to guildhall_app;

-- A global bar revokes every guild's run tokens, so the app must be able to enumerate guild ids,
-- which forced RLS on `guilds` otherwise forbids without a tenant. This owner-side function
-- returns opaque ids only, in id order, a page at a time; it reads nothing else.
create function list_guild_ids(p_after uuid, p_limit integer) returns setof uuid
  language sql stable security definer set search_path = public, pg_temp as $$
  select guild_id from guilds
  where p_after is null or guild_id > p_after
  order by guild_id limit least(greatest(p_limit, 1), 1000)
$$;

revoke all on function list_guild_ids(uuid, integer) from public;
grant execute on function list_guild_ids(uuid, integer) to guildhall_app;
