-- 0054 added model_usage_quest, which repeats 0030's model_usage_by_quest (same columns), and
-- model_usage_hall_day, whose leading columns make 0030's model_usage_by_hall redundant. Drop the
-- two redundant ones; 0054 is already applied, so this is a new migration.
drop index if exists model_usage_quest;
drop index if exists model_usage_by_hall;
