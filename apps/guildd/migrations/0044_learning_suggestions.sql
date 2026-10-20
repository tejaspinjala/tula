-- Suggested learnings read from the Guild Master's allowlisted repos (merged PR titles and
-- descriptions, ADR file titles). A suggestion is keyed by its stable source id and is never deleted,
-- so one that was accepted or dismissed is never suggested again. Accepting writes an Archive note;
-- note_id records which one.

create table learning_suggestions (
  guild_id uuid not null references guilds (guild_id),
  suggestion_id uuid not null default gen_random_uuid(),
  source_id text not null check (length(source_id) between 1 and 400),
  repo text not null check (length(repo) between 3 and 200),
  kind text not null check (kind in ('pr', 'adr')),
  title text not null check (length(title) between 1 and 200),
  body text not null check (length(body) between 1 and 4000),
  url text not null check (length(url) between 1 and 1000),
  status text not null default 'pending',
  note_id uuid,
  created_at timestamptz not null,
  decided_at timestamptz,
  primary key (guild_id, suggestion_id),
  constraint learning_suggestions_source unique (guild_id, source_id),
  constraint learning_suggestions_status_check
    check (status in ('pending', 'accepted', 'dismissed'))
);

alter table learning_suggestions enable row level security;
alter table learning_suggestions force row level security;
create policy learning_suggestions_tenant on learning_suggestions
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

-- No delete: a decided suggestion must stay to keep it from being suggested again.
grant select, insert, update on learning_suggestions to guildhall_app;
