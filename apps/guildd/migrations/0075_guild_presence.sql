-- The Guild Master's presence (away mode, ADR-0011): one row per guild holding the away flag, when
-- it began and the optional instant it ends by itself. A passed away_until counts as present; that
-- is decided by the pure isAway(state, now) in code, so no row needs rewriting when it passes.
-- Runtime state, never config. Upserted and deleted-by-flag, never row-deleted.

create table guild_presence (
  guild_id uuid primary key references guilds (guild_id),
  away boolean not null,
  away_since timestamptz,
  away_until timestamptz,
  updated_at timestamptz not null default now(),
  check ((away and away_since is not null) or (not away and away_since is null and away_until is null))
);

alter table guild_presence enable row level security;
alter table guild_presence force row level security;
create policy guild_presence_tenant on guild_presence
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select, insert, update on guild_presence to guildhall_app;
