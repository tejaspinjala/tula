-- Model gateway reservations (#18 review): a call charges its estimate before the provider is
-- called ('pending'), and is reconciled to actual usage afterwards ('settled'); an unsettled row
-- keeps its estimate as the charge. client_key is the caller's own idempotency key, unique per
-- run, so a reused key can never mean "call the provider but do not charge". The group indexes
-- let a cost-table page filter by key before aggregating.

alter table model_usage
  add column state text not null default 'settled' check (state in ('pending', 'settled')),
  add column client_key text check (length(client_key) between 1 and 200);

create unique index model_usage_client_key
  on model_usage (guild_id, run_id, client_key) where client_key is not null;
create index model_usage_by_run on model_usage (guild_id, run_id);
create index model_usage_by_quest on model_usage (guild_id, quest_id);
create index model_usage_by_hall on model_usage (guild_id, hall_id);

grant update on model_usage to guildhall_app;
