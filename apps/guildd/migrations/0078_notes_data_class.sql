-- A note carries a data class. Existing rows are internal; a note filed by a private-class Quest is private.
-- Reads that cross Halls omit private notes (the store filters on this column).
-- notes keeps its forced RLS (0014); the column is set at insert and never updated.

alter table notes
  add column data_class text not null default 'internal'
  check (data_class in ('public', 'internal', 'private'));
create index notes_guild_data_class on notes (guild_id, data_class);
