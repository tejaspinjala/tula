-- Workflows (ticket #73, ADR-0009): a saved, versioned graph per guild, and the instances that run
-- a pinned version. A version never changes once written; the only move is `pending` -> `active`
-- (a widening save waits for confirmation with a fresh re-authentication). The engine holds no
-- authority: instances only record that a run started; its Quests go through the normal queue.

create table workflow_versions (
  guild_id uuid not null references guilds (guild_id),
  workflow_id text not null check (workflow_id ~ '^[a-z][a-z0-9_-]{0,63}$'),
  version integer not null check (version >= 1),
  name text not null check (length(name) between 1 and 200),
  graph jsonb not null check (jsonb_typeof(graph) = 'object'),
  classification text not null check (classification in ('internal', 'widening')),
  status text not null check (status in ('active', 'pending')),
  created_at timestamptz not null,
  primary key (guild_id, workflow_id, version)
);

create table workflow_instances (
  guild_id uuid not null,
  instance_id uuid not null default gen_random_uuid(),
  workflow_id text not null,
  version integer not null,
  run_key text not null check (length(run_key) between 1 and 200),
  created_at timestamptz not null,
  primary key (guild_id, instance_id),
  unique (guild_id, workflow_id, run_key),
  foreign key (guild_id, workflow_id, version)
    references workflow_versions (guild_id, workflow_id, version)
);

alter table workflow_versions enable row level security;
alter table workflow_versions force row level security;
create policy workflow_versions_tenant on workflow_versions
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

alter table workflow_instances enable row level security;
alter table workflow_instances force row level security;
create policy workflow_instances_tenant on workflow_instances
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select, insert on workflow_versions to guildhall_app;
grant update (status) on workflow_versions to guildhall_app;
grant select, insert on workflow_instances to guildhall_app;

-- Immutable even for the owner. Runs with the caller's rights.
create function workflow_row_immutable() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception '%: rows are immutable; a changed Workflow is a new version', tg_table_name
    using errcode = 'check_violation';
end;
$$;

revoke all on function workflow_row_immutable() from public;

create trigger workflow_instances_immutable
  before update or delete on workflow_instances
  for each row execute function workflow_row_immutable();

create trigger workflow_versions_no_delete
  before delete on workflow_versions
  for each row execute function workflow_row_immutable();

-- A version may only move pending -> active; every other column is frozen.
create function workflow_version_frozen() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if (new.guild_id, new.workflow_id, new.version, new.name, new.graph, new.classification, new.created_at)
       is distinct from
     (old.guild_id, old.workflow_id, old.version, old.name, old.graph, old.classification, old.created_at)
     or (old.status = 'active' and new.status <> 'active') then
    raise exception '%: rows are immutable; a changed Workflow is a new version', tg_table_name
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function workflow_version_frozen() from public;

create trigger workflow_versions_frozen
  before update on workflow_versions
  for each row execute function workflow_version_frozen();
