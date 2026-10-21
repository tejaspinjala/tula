-- Bug Reports: a defect filed with a reproduction against the Hall that owns the broken work. Per
-- guild, forced RLS. Rows are never deleted. The only update is the move from open to fixed (status,
-- fix_handoff_hash, fixed_at), made inside the Handoff write of the Fix Quest. `seq` is the
-- newest-first page cursor. The per-Quest cap and the duplicate check run under a per-Quest and a
-- per-guild advisory lock taken by the store. A Guild Master report has no filing Quest.

create table bug_reports (
  guild_id uuid not null references guilds (guild_id),
  bug_report_id uuid not null default gen_random_uuid(),
  seq bigint generated always as identity,
  owning_hall text not null check (length(owning_hall) between 1 and 64),
  title text not null check (length(title) between 1 and 120),
  reproduction jsonb not null,
  reproduction_hash text not null check (reproduction_hash ~ '^[0-9a-f]{64}$'),
  evidence jsonb not null,
  filed_by text not null check (filed_by in ('member', 'guild_master')),
  filer_quest_id uuid,
  filer_hall_id text check (length(filer_hall_id) between 1 and 64),
  filer_member text check (length(filer_member) between 1 and 200),
  status text not null check (status in ('open', 'duplicate', 'fixed')),
  duplicate_of uuid,
  fix_quest_id uuid,
  fix_handoff_hash text check (fix_handoff_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null,
  fixed_at timestamptz,
  primary key (guild_id, bug_report_id),
  unique (guild_id, seq),
  foreign key (guild_id, duplicate_of) references bug_reports (guild_id, bug_report_id),
  check (
    (filed_by = 'member' and filer_quest_id is not null and filer_hall_id is not null
      and filer_member is not null)
    or (filed_by = 'guild_master' and filer_quest_id is null and filer_hall_id is null
      and filer_member is null)
  ),
  check ((status = 'duplicate') = (duplicate_of is not null)),
  check ((status = 'duplicate') = (fix_quest_id is null)),
  check ((status = 'fixed') = (fix_handoff_hash is not null and fixed_at is not null))
);

create index bug_reports_hall_seq on bug_reports (guild_id, owning_hall, seq desc);
create index bug_reports_hall_status_seq on bug_reports (guild_id, owning_hall, status, seq desc);
create index bug_reports_filer_quest on bug_reports (guild_id, filer_quest_id);
create unique index bug_reports_fix_quest on bug_reports (guild_id, fix_quest_id)
  where fix_quest_id is not null;
-- At most one open report per defect: the duplicate check's authority.
create unique index bug_reports_one_open on bug_reports (guild_id, owning_hall, reproduction_hash)
  where status = 'open';

alter table bug_reports enable row level security;
alter table bug_reports force row level security;
create policy bug_reports_tenant on bug_reports
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

-- No delete. Update is limited to the columns the open-to-fixed move writes.
grant select, insert on bug_reports to guildhall_app;
grant update (status, fix_handoff_hash, fixed_at) on bug_reports to guildhall_app;
