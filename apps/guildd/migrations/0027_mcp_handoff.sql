-- MCP gateway state. A Handoff is the schema-checked packet a Quest attempt ends with (one per
-- Quest and attempt, insert-only). quest_artifacts records which artifact hashes a Quest holds, so
-- artifact tools reach only a Quest's own artifacts. campaign_toolsets freezes the ordered tool
-- list of a role for a Campaign (scope is the Campaign id, or the Quest id when it has none), so a
-- tool added later is never exposed mid-Campaign. Rows are never updated or deleted.

create table handoffs (
  guild_id uuid not null references guilds (guild_id),
  quest_id uuid not null,
  attempt integer not null check (attempt >= 1),
  member_id text not null,
  handoff_hash text not null check (handoff_hash ~ '^[0-9a-f]{64}$'),
  body jsonb not null,
  created_at timestamptz not null default now(),
  primary key (guild_id, quest_id, attempt),
  foreign key (guild_id, quest_id) references quests (guild_id, quest_id)
);

create table quest_artifacts (
  guild_id uuid not null references guilds (guild_id),
  quest_id uuid not null,
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  size bigint not null check (size >= 0),
  created_at timestamptz not null default now(),
  primary key (guild_id, quest_id, hash),
  foreign key (guild_id, quest_id) references quests (guild_id, quest_id)
);

create table campaign_toolsets (
  guild_id uuid not null references guilds (guild_id),
  scope text not null check (length(scope) between 1 and 100),
  role text not null check (role in ('apprentice', 'journeyman', 'adept')),
  tools jsonb not null,
  created_at timestamptz not null default now(),
  primary key (guild_id, scope, role)
);

alter table handoffs enable row level security;
alter table handoffs force row level security;
create policy handoffs_tenant on handoffs
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

alter table quest_artifacts enable row level security;
alter table quest_artifacts force row level security;
create policy quest_artifacts_tenant on quest_artifacts
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

alter table campaign_toolsets enable row level security;
alter table campaign_toolsets force row level security;
create policy campaign_toolsets_tenant on campaign_toolsets
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select, insert on handoffs to guildhall_app;
grant select, insert on quest_artifacts to guildhall_app;
grant select, insert on campaign_toolsets to guildhall_app;
