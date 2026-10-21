-- Dossiers: code-generated, verified packets about another Hall's finished Quest. Per guild, forced
-- RLS. Rows are insert-only (the app role never updates or deletes), each carrying the dossier
-- hash; a repeat request is a new row. `seq` is the newest-first page cursor. The per-Quest cap is
-- checked by the store under a per-Quest advisory lock. A Guild Master request has no requester Quest.

create table dossiers (
  guild_id uuid not null references guilds (guild_id),
  dossier_id uuid not null default gen_random_uuid(),
  seq bigint generated always as identity,
  subject_quest_id uuid not null,
  subject_hall_id text not null check (length(subject_hall_id) between 1 and 64),
  requested_by text not null check (requested_by in ('member', 'guild_master')),
  requester_quest_id uuid,
  requester_hall_id text check (length(requester_hall_id) between 1 and 64),
  requester_member text check (length(requester_member) between 1 and 200),
  body jsonb not null,
  dossier_hash text not null check (dossier_hash ~ '^[0-9a-f]{64}$'),
  verified boolean not null,
  failed_checks jsonb not null,
  created_at timestamptz not null,
  primary key (guild_id, dossier_id),
  unique (guild_id, seq),
  check (
    (requested_by = 'member' and requester_quest_id is not null and requester_hall_id is not null
      and requester_member is not null)
    or (requested_by = 'guild_master' and requester_quest_id is null and requester_hall_id is null
      and requester_member is null)
  )
);

create index dossiers_subject_hall_seq on dossiers (guild_id, subject_hall_id, seq desc);
create index dossiers_requester_hall_seq on dossiers (guild_id, requester_hall_id, seq desc);
create index dossiers_requester_quest on dossiers (guild_id, requester_quest_id);

alter table dossiers enable row level security;
alter table dossiers force row level security;
create policy dossiers_tenant on dossiers
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

-- Insert-only: the app role reads and inserts, never updates or deletes.
grant select, insert on dossiers to guildhall_app;
