-- Rite saves (ticket #194): one row per (guild, Rite, save id) holding the version the first save
-- with that id returned, so a retried save changes nothing and answers the same. Per guild, forced
-- RLS; insert-only (the app role never updates or deletes).

create table rite_saves (
  guild_id uuid not null references guilds (guild_id),
  workflow_id text not null,
  save_id text not null check (length(save_id) between 1 and 200),
  version integer not null check (version >= 1),
  created_at timestamptz not null default now(),
  primary key (guild_id, workflow_id, save_id)
);

alter table rite_saves enable row level security;
alter table rite_saves force row level security;
create policy rite_saves_tenant on rite_saves
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select, insert on rite_saves to guildhall_app;
