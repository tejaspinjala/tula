-- Core Loop: a Seal belongs to a Quest round. A revision after a denial is a new round and a new
-- Seal row for the same text, so the idempotency key becomes (quest, round, hash) instead of
-- (quest, hash). The request stays immutable: `round` is set on insert and never updated (the
-- app role's column grants in 0020 allow update on the whole table, but seals_guard rejects
-- any change to the request fields, and the application never writes `round` after insert).

alter table seals add column round integer not null default 1 check (round >= 1);

alter table seals drop constraint seals_guild_id_quest_id_action_hash_key;
alter table seals add constraint seals_quest_round_hash_key
  unique (guild_id, quest_id, round, action_hash);

create index seals_guild_quest_round on seals (guild_id, quest_id, round desc);
