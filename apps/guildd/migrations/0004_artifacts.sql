-- Artifacts: large payloads live in the content-addressed ObjectStore; this row records which
-- hashes a guild holds, how big they are and their class. Unique per (guild_id, hash).

create table artifacts (
  guild_id uuid not null references guilds (guild_id),
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  size bigint not null check (size >= 0),
  class text not null check (class ~ '^[a-z][a-z0-9_-]{0,63}$'),
  created_at timestamptz not null default now(),
  primary key (guild_id, hash)
);

alter table artifacts enable row level security;
alter table artifacts force row level security;

create policy artifacts_tenant on artifacts
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select, insert, update, delete on artifacts to guildhall_app;
