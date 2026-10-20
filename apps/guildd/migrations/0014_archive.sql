-- The Archive: notes (text or link) with every NoteVersion kept, NoteLinks from [[wiki links]],
-- and full-text search over each version. A fact carries evidence; an assumption is quarantined.
-- Versions and links are insert-only; only notes.current_version is ever updated.

create table notes (
  guild_id uuid not null references guilds (guild_id),
  note_id uuid not null default gen_random_uuid(),
  kind text not null check (kind in ('text', 'link')),
  current_version integer not null,
  created_at timestamptz not null default now(),
  primary key (guild_id, note_id)
);

create table note_versions (
  guild_id uuid not null,
  note_id uuid not null,
  version integer not null check (version >= 1),
  title text not null check (length(title) between 1 and 200),
  body text not null check (length(body) between 1 and 20000),
  trust text not null check (trust in ('fact', 'quarantined')),
  evidence text,
  check (trust <> 'fact' or length(coalesce(evidence, '')) > 0),
  search tsvector generated always as (to_tsvector('simple', title || ' ' || body)) stored,
  created_at timestamptz not null default now(),
  primary key (guild_id, note_id, version),
  foreign key (guild_id, note_id) references notes (guild_id, note_id)
);
create index note_versions_search on note_versions using gin (search);

-- One row per [[target]] in a version's body; target_key is the lower-cased trimmed link text.
create table note_links (
  guild_id uuid not null,
  note_id uuid not null,
  version integer not null,
  target_key text not null,
  primary key (guild_id, note_id, version, target_key),
  foreign key (guild_id, note_id, version) references note_versions (guild_id, note_id, version)
);
create index note_links_target on note_links (guild_id, target_key);

alter table notes enable row level security;
alter table notes force row level security;
create policy notes_tenant on notes
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

alter table note_versions enable row level security;
alter table note_versions force row level security;
create policy note_versions_tenant on note_versions
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

alter table note_links enable row level security;
alter table note_links force row level security;
create policy note_links_tenant on note_links
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select, insert, update on notes to guildhall_app;
grant select, insert on note_versions to guildhall_app;
grant select, insert on note_links to guildhall_app;
