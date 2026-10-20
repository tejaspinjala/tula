-- Abuse limits for unauthenticated routes (sign-in, passkey and founding ceremonies).
--
-- Deliberately NOT a tenant table: no guild_id column, no row level security. A bucket is keyed
-- by client address or by a guild id taken from the URL, and the limit must also hold for guilds
-- that do not exist and for callers with no guild at all, so there is no tenant to scope it to.
-- It holds only opaque bucket keys and counters, never guild data; the app role may touch only
-- this table through Db.bumpRateLimit. Exempt in src/testing/rls-check.ts (NOT_TENANT).
-- Shared in Postgres (not process memory) so every instance sees the same counts.

create table rate_limits (
  bucket text not null,
  window_start timestamptz not null,
  hits integer not null check (hits >= 1),
  primary key (bucket, window_start)
);
create index rate_limits_window on rate_limits (window_start);

grant select, insert, update, delete on rate_limits to guildhall_app;
