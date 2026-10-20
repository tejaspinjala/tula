-- The link from a sub-Quest to the Quest that spawned it (the "Subagents" pattern): its depth, the
-- parent's delivery that spawned it, the hash of the spawn request (so a retried spawn is
-- idempotent per parent, attempt and request) and the data class the child inherited. Rows are
-- never updated or deleted. Per guild, forced RLS, every key and foreign key carries guild_id.

create table quest_children (
  guild_id uuid not null references guilds (guild_id),
  parent_id uuid not null,
  child_id uuid not null,
  depth integer not null check (depth >= 1),
  attempt integer not null check (attempt >= 1),
  brief_hash text not null check (brief_hash ~ '^[0-9a-f]{64}$'),
  data_class text not null check (data_class in ('public', 'internal', 'private')),
  created_at timestamptz not null default now(),
  primary key (guild_id, child_id),
  unique (guild_id, parent_id, attempt, brief_hash),
  foreign key (guild_id, parent_id) references quests (guild_id, quest_id),
  foreign key (guild_id, child_id) references quests (guild_id, quest_id)
);

create index quest_children_guild_parent on quest_children (guild_id, parent_id);

alter table quest_children enable row level security;
alter table quest_children force row level security;
create policy quest_children_tenant on quest_children
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select, insert on quest_children to guildhall_app;
