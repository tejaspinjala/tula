-- Inquiries: one precise question a Member's Hall asks another Hall, answered once by a Member
-- working the answer Quest posted on the target Hall's Quest Board. Per guild, forced RLS. The
-- question and answer are untrusted: stored and shown as data. `seq` is the newest-first page
-- cursor; `dedupe_key` makes an ask idempotent within one Quest attempt; the per-Quest cap is
-- checked by the store under a per-Quest advisory lock. The app role may update an Inquiry (to
-- answer, expire or file its note) but never delete one.

create table inquiries (
  guild_id uuid not null references guilds (guild_id),
  inquiry_id uuid not null,
  seq bigint generated always as identity,
  from_hall text not null check (length(from_hall) between 1 and 64),
  to_hall text not null check (length(to_hall) between 1 and 64),
  ask_quest_id uuid not null,
  answer_quest_id uuid not null,
  asker text not null check (length(asker) between 1 and 200),
  question text not null check (length(question) between 1 and 1000),
  status text not null default 'open' check (status in ('open', 'answered', 'expired')),
  answer text check (answer is null or length(answer) between 1 and 4000),
  answered_by text check (answered_by is null or length(answered_by) between 1 and 200),
  note_id uuid,
  asked_at timestamptz not null,
  expires_at timestamptz not null,
  answered_at timestamptz,
  dedupe_key text not null check (length(dedupe_key) <= 200),
  primary key (guild_id, inquiry_id),
  unique (guild_id, dedupe_key),
  unique (guild_id, seq)
);

create index inquiries_from_seq on inquiries (guild_id, from_hall, seq desc);
create index inquiries_to_seq on inquiries (guild_id, to_hall, seq desc);
create index inquiries_ask_quest on inquiries (guild_id, ask_quest_id);
create index inquiries_open_expiry on inquiries (guild_id, expires_at) where status = 'open';

alter table inquiries enable row level security;
alter table inquiries force row level security;
create policy inquiries_tenant on inquiries
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select, insert, update on inquiries to guildhall_app;
