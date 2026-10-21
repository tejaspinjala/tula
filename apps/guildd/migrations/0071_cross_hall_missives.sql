-- Cross-Hall Missives: a Missive keeps its sending Hall (hall_id) and, when it goes to another
-- Hall, that destination (to_hall). Null to_hall means the Missive stays inside hall_id. The
-- table already has guild_id and forced RLS (0065); the new column adds no new access.

alter table missives
  add column to_hall text check (to_hall is null or length(to_hall) between 1 and 64);

create index missives_to_hall_seq on missives (guild_id, to_hall, seq desc) where to_hall is not null;
