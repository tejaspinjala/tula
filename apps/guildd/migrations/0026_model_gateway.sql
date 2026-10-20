-- The model gateway (#18): per-run tokens, the metering ledger and the once-a-day cap notice.
-- A run's token is stored only as its SHA-256 hash; the token itself is shown once, to the
-- run. Usage rows are insert-only and idempotent per call_key. Dollars are kept in millionths
-- (cost_micros) so no float ever enters a cap comparison; null means the provider bills no
-- dollars (subscription).

create table model_runs (
  guild_id uuid not null references guilds (guild_id),
  run_id text not null check (length(run_id) between 1 and 200),
  seq bigint generated always as identity,
  quest_id text not null check (length(quest_id) between 1 and 200),
  hall_id text not null check (length(hall_id) between 1 and 64),
  provider_id text not null,
  profile_id text not null,
  state text not null check (state in ('queued', 'active', 'revoked')),
  token_hash text check (length(token_hash) between 1 and 200),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (guild_id, run_id),
  unique (guild_id, token_hash),
  unique (guild_id, seq),
  check ((state = 'queued') = (token_hash is null) or state = 'revoked')
);

create table model_usage (
  guild_id uuid not null references guilds (guild_id),
  call_key text not null check (length(call_key) between 1 and 200),
  run_id text not null,
  quest_id text not null,
  hall_id text not null,
  day date not null,
  input_tokens bigint not null check (input_tokens >= 0),
  output_tokens bigint not null check (output_tokens >= 0),
  cost_micros bigint check (cost_micros >= 0),
  created_at timestamptz not null default now(),
  primary key (guild_id, call_key),
  foreign key (guild_id, run_id) references model_runs (guild_id, run_id)
);
create index model_usage_day on model_usage (guild_id, day);

-- One row per guild-day: the dedupe that makes the Steward's cap notice fire once.
create table model_cap_notices (
  guild_id uuid not null references guilds (guild_id),
  day date not null,
  reason text not null,
  created_at timestamptz not null default now(),
  primary key (guild_id, day)
);

alter table model_runs enable row level security;
alter table model_runs force row level security;
create policy model_runs_tenant on model_runs
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

alter table model_usage enable row level security;
alter table model_usage force row level security;
create policy model_usage_tenant on model_usage
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

alter table model_cap_notices enable row level security;
alter table model_cap_notices force row level security;
create policy model_cap_notices_tenant on model_cap_notices
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select, insert, update on model_runs to guildhall_app;
grant select, insert on model_usage to guildhall_app;
grant select, insert on model_cap_notices to guildhall_app;
