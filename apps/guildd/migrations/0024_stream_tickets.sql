-- Single-use tickets for the live event stream. A browser WebSocket cannot send an Authorization
-- header, so a signed-in client trades its session for a short-lived ticket and connects with that.
-- Only the ticket's hash is stored; consuming it is one atomic UPDATE.

create table stream_tickets (
  guild_id uuid not null references guilds (guild_id),
  ticket_hash text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  primary key (guild_id, ticket_hash)
);

alter table stream_tickets enable row level security;
alter table stream_tickets force row level security;
create policy stream_tickets_tenant on stream_tickets
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select, insert on stream_tickets to guildhall_app;
grant update (consumed_at) on stream_tickets to guildhall_app;
