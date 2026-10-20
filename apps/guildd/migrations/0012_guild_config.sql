-- Versioned guild config. Every change is a new row; a risk-widening change is stored `pending`
-- and takes effect only when confirmed (the app flips status to `applied`). The config in force
-- is the highest `applied` version. Rows are never deleted, and only `status` is ever updated.

create table guild_config_versions (
  guild_id uuid not null references guilds (guild_id),
  version integer not null check (version >= 1),
  status text not null check (status in ('applied', 'pending')),
  kind text not null check (kind in ('seed', 'change', 'restore')),
  change text not null check (change in ('widening', 'tightening', 'neutral')),
  base_version integer,
  config jsonb not null,
  created_at timestamptz not null default now(),
  primary key (guild_id, version)
);

alter table guild_config_versions enable row level security;
alter table guild_config_versions force row level security;
create policy guild_config_versions_tenant on guild_config_versions
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select, insert on guild_config_versions to guildhall_app;
grant update (status) on guild_config_versions to guildhall_app;
