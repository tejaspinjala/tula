-- The Guild Master's character look (ADR-0009): one row per guild, so the character is the same on
-- every device. The look is a set of catalogue indexes (validated by the app against a fixed
-- catalogue); it is cosmetic and never read by governance. Saved by upsert, never deleted.

create table guild_master_looks (
  guild_id uuid primary key references guilds (guild_id),
  look jsonb not null check (jsonb_typeof(look) = 'object'),
  updated_at timestamptz not null default now()
);

alter table guild_master_looks enable row level security;
alter table guild_master_looks force row level security;
create policy guild_master_looks_tenant on guild_master_looks
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select, insert, update on guild_master_looks to guildhall_app;
