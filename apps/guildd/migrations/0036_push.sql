-- Web push for the Guild Master's installed PWA: device subscriptions, per-(Seal, subscription)
-- delivery claims that make a retried dispatch idempotent, and a per-guild cursor over the event
-- log so no `seal.requested` event is missed or pushed twice. The push payload never carries
-- Seal text, so nothing here stores any.

create table push_subscriptions (
  guild_id uuid not null references guilds (guild_id),
  endpoint text not null,
  member_id uuid not null,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  primary key (guild_id, endpoint)
);

create table push_deliveries (
  guild_id uuid not null,
  seal_id uuid not null,
  endpoint text not null,
  claimed_at timestamptz not null default now(),
  primary key (guild_id, seal_id, endpoint),
  foreign key (guild_id, endpoint) references push_subscriptions (guild_id, endpoint)
    on delete cascade
);

create table push_cursors (
  guild_id uuid not null references guilds (guild_id),
  last_seq bigint not null default 0,
  primary key (guild_id)
);

alter table push_subscriptions enable row level security;
alter table push_subscriptions force row level security;
create policy push_subscriptions_tenant on push_subscriptions
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

alter table push_deliveries enable row level security;
alter table push_deliveries force row level security;
create policy push_deliveries_tenant on push_deliveries
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

alter table push_cursors enable row level security;
alter table push_cursors force row level security;
create policy push_cursors_tenant on push_cursors
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select, insert, delete on push_subscriptions to guildhall_app;
grant update (member_id, p256dh, auth) on push_subscriptions to guildhall_app;
grant select, insert, delete on push_deliveries to guildhall_app;
grant select, insert on push_cursors to guildhall_app;
grant update (last_seq) on push_cursors to guildhall_app;
