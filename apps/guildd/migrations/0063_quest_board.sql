-- A Quest posted to a Hall's Quest Board (the "Hall teams" pattern): it belongs to a Campaign but
-- is not serialised with the Campaign's other Quests, so a Hall's Members can claim board Quests
-- in parallel. The column lives on the existing per-guild, forced-RLS quests table.

alter table quests add column board boolean not null default false;
