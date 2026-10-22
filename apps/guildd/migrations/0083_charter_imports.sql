-- Charter imports (ticket #183, spec #180): one row per (guild, import id) holding the result the
-- first import returned, so a retried import changes nothing and answers the same. Per guild, forced
-- RLS; insert-only (the app role never updates or deletes).

create table charter_imports (
  guild_id uuid not null references guilds (guild_id),
  import_id text not null check (length(import_id) between 1 and 200),
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (guild_id, import_id)
);

alter table charter_imports enable row level security;
alter table charter_imports force row level security;
create policy charter_imports_tenant on charter_imports
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select, insert on charter_imports to guildhall_app;
