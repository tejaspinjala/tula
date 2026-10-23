-- Mailbox read markers (ticket #219): one row per (guild, Hall) holding the newest Inquiry seq the
-- Guild Master has seen in that Hall's Mailbox, so the unread count is real. The app only ever
-- raises it (upsert with greatest), so a replayed older marker changes nothing. Per guild, forced RLS.

create table mailbox_read_markers (
  guild_id uuid not null references guilds (guild_id),
  hall_id text not null check (length(hall_id) between 1 and 200),
  seen_seq bigint not null check (seen_seq >= 0),
  updated_at timestamptz not null default now(),
  primary key (guild_id, hall_id)
);

alter table mailbox_read_markers enable row level security;
alter table mailbox_read_markers force row level security;
create policy mailbox_read_markers_tenant on mailbox_read_markers
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select, insert, update on mailbox_read_markers to guildhall_app;
