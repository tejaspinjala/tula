-- A Quest that spawned sub-Quests gives its worker slot back and waits on them: `wait_on` holds the
-- sub-Quest ids and `wait_mode` the fan-in ('all' or 'any'). Both are cleared by the next claim.
-- Additive columns on `quests`; the table keeps its guild_id, forced RLS and policy (0018).

alter table quests add column wait_on uuid[] not null default '{}';
alter table quests add column wait_mode text not null default 'all' check (wait_mode in ('all', 'any'));

grant update (wait_on, wait_mode) on quests to guildhall_app;
