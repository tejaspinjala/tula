-- Missives: short messages Members of one Hall send each other (or the whole Hall) while they
-- work. Per guild, forced RLS. The text is untrusted: it is stored and shown as data. `seq` is the
-- newest-first page cursor; `dedupe_key` makes a send idempotent within one Quest attempt; the
-- per-Quest cap is checked by the store under a per-Quest advisory lock.

create table missives (
  guild_id uuid not null references guilds (guild_id),
  missive_id uuid not null default gen_random_uuid(),
  seq bigint generated always as identity,
  hall_id text not null check (length(hall_id) between 1 and 64),
  quest_id uuid not null,
  sender text not null check (length(sender) between 1 and 200),
  addressee text not null check (length(addressee) between 1 and 200),
  body text not null check (length(body) between 1 and 2000),
  sent_at timestamptz not null,
  dedupe_key text not null check (length(dedupe_key) <= 200),
  primary key (guild_id, missive_id),
  unique (guild_id, dedupe_key),
  unique (guild_id, seq)
);

create index missives_hall_seq on missives (guild_id, hall_id, seq desc);
create index missives_quest on missives (guild_id, quest_id);

alter table missives enable row level security;
alter table missives force row level security;
create policy missives_tenant on missives
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

-- Append-only: the app role reads and inserts, never updates or deletes.
grant select, insert on missives to guildhall_app;
