-- Archiving a Rite (ticket #175, spec #172): a Rite has no row of its own (it is the set of its
-- versions in workflow_versions, whose rows are frozen), so its archive state lives in this small
-- per-Rite table. A row exists once a Rite has been archived; `archived_at` is null again after an
-- unarchive. Stored names keep the old word (ADR-0013).

create table workflow_archive (
  guild_id uuid not null references guilds (guild_id),
  workflow_id text not null check (workflow_id ~ '^[a-z][a-z0-9_-]{0,63}$'),
  archived_at timestamptz,
  primary key (guild_id, workflow_id)
);

alter table workflow_archive enable row level security;
alter table workflow_archive force row level security;
create policy workflow_archive_tenant on workflow_archive
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select, insert on workflow_archive to guildhall_app;
grant update (archived_at) on workflow_archive to guildhall_app;
