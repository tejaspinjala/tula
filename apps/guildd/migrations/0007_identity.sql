-- Identity (ADR-0007): the Guild Master's passkeys, one-use ceremony challenges and sessions.
-- All three are tenant tables; a session token embeds its guild id so lookups run tenant-scoped.

create table identity_credentials (
  guild_id uuid not null references guilds (guild_id),
  credential_id text not null,
  public_key text not null,
  counter bigint not null default 0 check (counter >= 0),
  transports text[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key (guild_id, credential_id)
);

create table identity_challenges (
  guild_id uuid not null references guilds (guild_id),
  challenge_id uuid not null,
  kind text not null check (kind in ('register', 'signin', 'reauth')),
  challenge text not null,
  session_id uuid,
  expires_at timestamptz not null,
  primary key (guild_id, challenge_id)
);

create table identity_sessions (
  guild_id uuid not null references guilds (guild_id),
  session_id uuid not null,
  token_hash text not null,
  expires_at timestamptz not null,
  reauth_hash text,
  reauth_expires_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (guild_id, session_id),
  unique (guild_id, token_hash)
);

alter table identity_credentials enable row level security;
alter table identity_credentials force row level security;
create policy identity_credentials_tenant on identity_credentials
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

alter table identity_challenges enable row level security;
alter table identity_challenges force row level security;
create policy identity_challenges_tenant on identity_challenges
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

alter table identity_sessions enable row level security;
alter table identity_sessions force row level security;
create policy identity_sessions_tenant on identity_sessions
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select, insert, update, delete on identity_credentials, identity_challenges, identity_sessions
  to guildhall_app;
