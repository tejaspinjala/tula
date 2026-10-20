-- The routing decision log (ADR-0006): one row per routing decision, kept as training data for
-- the future Oracle. Insert-only. A free-text goal is stored only as a SHA-256, never as text,
-- because the goal may be private. decision_key makes a retried handler log once.

create table routing_decisions (
  guild_id uuid not null references guilds (guild_id),
  seq bigint generated always as identity,
  decision_key text not null check (length(decision_key) between 1 and 200),
  source text not null check (source in ('template', 'classifier', 'fallback')),
  goal_sha256 text check (goal_sha256 ~ '^[0-9a-f]{64}$'),
  hall_id text,
  rank text check (rank in ('apprentice', 'journeyman', 'adept')),
  data_class text check (data_class in ('public', 'internal', 'private')),
  classifier_claim jsonb,
  outcome text not null check (outcome in ('routed', 'blocked')),
  provider_id text,
  profile_id text,
  reason text,
  created_at timestamptz not null default now(),
  primary key (guild_id, seq),
  unique (guild_id, decision_key),
  check ((outcome = 'routed') = (provider_id is not null)),
  check ((outcome = 'blocked') = (reason is not null))
);

alter table routing_decisions enable row level security;
alter table routing_decisions force row level security;
create policy routing_decisions_tenant on routing_decisions
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select, insert on routing_decisions to guildhall_app;
