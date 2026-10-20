-- Push delivery state. A delivery claim is now leased (`pending` until `lease_expires_at`, so a
-- sender that crashed after claiming is retried), counts its attempts (so a device that keeps
-- failing is eventually given up on), and ends `sent` or `failed`. A subscription records the
-- event seq it was made at, so events from before it existed are never pushed to it.
-- Rows written by 0036 were claims that were treated as sent: they default to `sent`.

alter table push_deliveries
  add column state text not null default 'sent' check (state in ('pending', 'sent', 'failed')),
  add column attempts integer not null default 1,
  add column lease_expires_at timestamptz not null default now();

alter table push_subscriptions
  add column since_seq bigint not null default 0;

grant update (state, attempts, lease_expires_at) on push_deliveries to guildhall_app;

-- The dispatch lease: at most one process dispatches a guild's pushes at a time. A short atomic
-- upsert takes or renews it and it expires by itself, so nothing is held open across the network
-- sends (a held transaction per guild would starve the connection pool).
create table push_dispatch_leases (
  guild_id uuid not null references guilds (guild_id),
  holder text not null,
  until timestamptz not null,
  primary key (guild_id)
);

alter table push_dispatch_leases enable row level security;
alter table push_dispatch_leases force row level security;
create policy push_dispatch_leases_tenant on push_dispatch_leases
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select, insert, delete on push_dispatch_leases to guildhall_app;
grant update (holder, until) on push_dispatch_leases to guildhall_app;

-- Deliberately NOT a tenant table (like rate_limits, 0016): the ids of guilds that have a push
-- subscription, so a restarted relay can find guilds whose log is ahead of their push cursor
-- without a tenantless read of tenant tables. It holds opaque guild ids and nothing else; the
-- guild's own data is still read only through `Db.withGuild`.
create table push_guilds (
  guild_id uuid primary key references guilds (guild_id)
);

grant select, insert on push_guilds to guildhall_app;
