-- Notes may be filed under a Hall. A null hall is the Guild Master's own note, visible to no
-- Member. The column is set on insert only; RLS and grants are unchanged.

alter table notes add column hall_id text;
create index notes_guild_hall on notes (guild_id, hall_id);
