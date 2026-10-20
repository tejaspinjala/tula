-- Gateway review: a run token is bound to the Quest attempt (delivery) it was opened for. The
-- gateway re-reads the Quest on every call and refuses the token once the attempt is no longer the
-- Quest's live lease. Runs that predate the column belong to the first attempt.

alter table model_runs
  add column attempt integer not null default 1 check (attempt >= 1);
alter table model_runs alter column attempt drop default;

-- Usage immutability (gateway review): 0030 granted update on model_usage table-wide, so the app
-- role could rewrite a charge's run, day or key. It may now touch only the settle columns, and a
-- trigger allows only the one pending -> settled transition, freezing the identity columns.

revoke update on model_usage from guildhall_app;
grant update (state, input_tokens, output_tokens, cost_micros) on model_usage to guildhall_app;

create function model_usage_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if old.state <> 'pending' or new.state <> 'settled' then
    raise exception 'model_usage: only a pending charge can be settled' using errcode = '23514';
  end if;
  if new.guild_id is distinct from old.guild_id
     or new.call_key is distinct from old.call_key
     or new.run_id is distinct from old.run_id
     or new.quest_id is distinct from old.quest_id
     or new.hall_id is distinct from old.hall_id
     or new.day is distinct from old.day
     or new.client_key is distinct from old.client_key then
    raise exception 'model_usage: identity columns are immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger model_usage_guard before update on model_usage
  for each row execute function model_usage_guard();
