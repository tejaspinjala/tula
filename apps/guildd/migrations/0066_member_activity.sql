-- Member activity coalescing: the last instant a Member's one activity was emitted as a
-- `member.activity` event, so repeats inside the window are dropped durably (no process memory).
-- Ids and the closed activity name only, never any text. Per guild, forced RLS. The app role
-- upserts the row and never deletes it.

create table member_activity (
  guild_id uuid not null references guilds (guild_id),
  member_id text not null check (length(member_id) between 1 and 200),
  activity text not null check (length(activity) between 1 and 40),
  last_at timestamptz not null,
  primary key (guild_id, member_id, activity)
);

alter table member_activity enable row level security;
alter table member_activity force row level security;
create policy member_activity_tenant on member_activity
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select, insert, update on member_activity to guildhall_app;
