-- Quests and the queue behind them. A Quest is one unit of work with exactly one owner, a
-- done-condition and a lease. Delivery is at-least-once: a lapsed lease is reclaimable. The job key
-- de-duplicates posts; `seq` is the posting order that serial Campaigns follow; `dead` Quests are
-- the dead-letter list. Rows are never deleted.

create table quests (
  guild_id uuid not null references guilds (guild_id),
  quest_id uuid not null default gen_random_uuid(),
  seq bigint generated always as identity,
  job_key text not null,
  campaign_id text,
  template_id text not null,
  hall_id text not null,
  rank text not null check (rank in ('apprentice', 'journeyman', 'adept')),
  data_class text not null check (data_class in ('public', 'internal', 'private')),
  title text not null,
  owner_id text not null,
  done_condition text not null,
  state text not null check (state in ('queued', 'active', 'awaiting_seal', 'done', 'dead')),
  round integer not null default 0 check (round >= 0),
  round_limit integer not null check (round_limit >= 1),
  blocked_by uuid[] not null default '{}',
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null check (max_attempts >= 1),
  lease_expires_at timestamptz,
  not_before timestamptz not null,
  last_error text,
  created_at timestamptz not null default now(),
  primary key (guild_id, quest_id),
  unique (guild_id, job_key),
  unique (guild_id, seq)
);

create index quests_guild_state_seq on quests (guild_id, state, seq);
create index quests_guild_campaign_seq on quests (guild_id, campaign_id, seq);

alter table quests enable row level security;
alter table quests force row level security;
create policy quests_tenant on quests
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select, insert on quests to guildhall_app;
grant update (state, round, attempts, lease_expires_at, not_before, last_error) on quests to guildhall_app;
