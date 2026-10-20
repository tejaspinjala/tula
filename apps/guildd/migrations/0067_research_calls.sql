-- Research calls: the slots a Quest holds against its per-Quest research cap. Per guild, forced
-- RLS. A row holds ids and a hash of the query, never the query or any result. A slot is taken
-- before a query leaves (cap checked under a per-Quest advisory lock) and freed by stamping
-- `released_at` when the call did not happen; the Treasury charge lives in the Treasury ledger.

create table research_calls (
  guild_id uuid not null references guilds (guild_id),
  call_id uuid not null default gen_random_uuid(),
  hall_id text not null check (length(hall_id) between 1 and 64),
  quest_id uuid not null,
  attempt int not null check (attempt >= 1),
  member_id text not null check (length(member_id) between 1 and 200),
  query_hash text not null check (query_hash ~ '^[0-9a-f]{64}$'),
  made_at timestamptz not null,
  released_at timestamptz,
  primary key (guild_id, call_id)
);

create index research_calls_quest on research_calls (guild_id, quest_id) where released_at is null;

alter table research_calls enable row level security;
alter table research_calls force row level security;
create policy research_calls_tenant on research_calls
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

-- The app role reads and inserts, and may only stamp a slot released.
grant select, insert on research_calls to guildhall_app;
grant update (released_at) on research_calls to guildhall_app;
