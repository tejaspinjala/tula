-- The Council of Elders (ADR-0011, #149): one session per (guild, Proposal hash), created before any
-- voice runs so a restart resumes it, and one insert-only vote per (session, voice). The session's
-- status moves open -> escalated | approved once (and claim columns move); a vote is never updated or deleted.
-- Reasons are untrusted model text kept bounded; they are served only as Seal evidence.

create table council_sessions (
  guild_id uuid not null references guilds (guild_id),
  session_id uuid not null default gen_random_uuid(),
  quest_id text not null check (length(quest_id) between 1 and 200),
  proposal_hash text not null check (proposal_hash ~ '^[0-9a-f]{64}$'),
  day date not null,
  status text not null default 'open' check (status in ('open', 'escalated', 'approved')),
  reason text check (length(reason) between 1 and 100),
  -- A worker running the voices holds the session until this instant; an expired claim can be
  -- taken over. No transaction is held across the model calls: the claim is the lock.
  claimed_until timestamptz,
  -- Who holds the claim (a random id per worker run): only the owner renews or releases it.
  claim_owner text check (length(claim_owner) between 1 and 100),
  -- Convene attempts that halted for a reason other than Bar the Gates; three escalate the session.
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  created_at timestamptz not null default now(),
  primary key (guild_id, session_id),
  unique (guild_id, proposal_hash),
  check ((status = 'escalated') = (reason is not null))
);
create index council_sessions_day on council_sessions (guild_id, day);

-- Council approvals are counted per Quest, not per session: sessions are unique on (guild, Proposal
-- hash) across Quests, so two Quests with the same hash each consume their own approval against the
-- daily cap. One row per (session, Quest); a retry finds its row instead of consuming another.
create table council_approvals (
  guild_id uuid not null,
  session_id uuid not null,
  quest_id text not null check (length(quest_id) between 1 and 200),
  day date not null,
  created_at timestamptz not null default now(),
  primary key (guild_id, session_id, quest_id),
  foreign key (guild_id, session_id) references council_sessions (guild_id, session_id)
);
create index council_approvals_day on council_approvals (guild_id, day);

create table council_votes (
  guild_id uuid not null,
  session_id uuid not null,
  voice text not null check (voice in ('architect', 'skeptic', 'security', 'ops', 'user')),
  vote text not null check (vote in ('approve', 'block', 'abstain')),
  reasons jsonb not null default '[]'::jsonb check (jsonb_typeof(reasons) = 'array'),
  abstain_code text check (abstain_code in ('invalid_output', 'failed', 'cap_reached')),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  cost_micros bigint check (cost_micros >= 0),
  created_at timestamptz not null default now(),
  primary key (guild_id, session_id, voice),
  foreign key (guild_id, session_id) references council_sessions (guild_id, session_id),
  check ((vote = 'abstain') or abstain_code is null)
);

-- Votes are insert-only; a session may only be escalated, once, and nothing else about it changes.
create function council_votes_immutable() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'council_votes are insert-only';
end;
$$;
create trigger council_votes_no_change before update or delete on council_votes
  for each row execute function council_votes_immutable();

create function council_sessions_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'council_sessions are never deleted';
  end if;
  if new.guild_id is distinct from old.guild_id
     or new.session_id is distinct from old.session_id
     or new.quest_id is distinct from old.quest_id
     or new.proposal_hash is distinct from old.proposal_hash
     or new.day is distinct from old.day
     or new.created_at is distinct from old.created_at
     or old.status <> 'open'
     or new.status not in ('open', 'escalated', 'approved') then
    raise exception 'a council session can only be claimed, escalated or approved, once';
  end if;
  return new;
end;
$$;
create trigger council_sessions_guard_trg before update or delete on council_sessions
  for each row execute function council_sessions_guard();

alter table council_sessions enable row level security;
alter table council_sessions force row level security;
create policy council_sessions_tenant on council_sessions
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

-- One row per (session, Quest) halted by Bar the Gates, so the audit chain records the halt once
-- however many passes find the guild still barred.
create table council_halts (
  guild_id uuid not null,
  session_id uuid not null,
  quest_id text not null check (length(quest_id) between 1 and 200),
  created_at timestamptz not null default now(),
  primary key (guild_id, session_id, quest_id),
  foreign key (guild_id, session_id) references council_sessions (guild_id, session_id)
);
alter table council_halts enable row level security;
alter table council_halts force row level security;
create policy council_halts_tenant on council_halts
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);
create trigger council_halts_no_change before update or delete on council_halts
  for each row execute function council_votes_immutable();
grant select, insert on council_halts to guildhall_app;

alter table council_approvals enable row level security;
alter table council_approvals force row level security;
create policy council_approvals_tenant on council_approvals
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

create trigger council_approvals_no_change before update or delete on council_approvals
  for each row execute function council_votes_immutable();

alter table council_votes enable row level security;
alter table council_votes force row level security;
create policy council_votes_tenant on council_votes
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select, insert, update on council_sessions to guildhall_app;
grant select, insert on council_votes to guildhall_app;
grant select, insert on council_approvals to guildhall_app;
