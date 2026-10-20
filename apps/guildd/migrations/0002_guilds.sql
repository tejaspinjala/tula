-- Tenancy foundation: the app role, the transaction-local tenant setting and the first tenant table.
-- Every tenant table: guild_id column, ENABLE + FORCE RLS, a policy on app.guild_id, composite keys.

do $$
begin
  create role guildhall_app login nosuperuser nobypassrls noinherit;
exception
  when duplicate_object or unique_violation then null;
end
$$;

-- A pre-existing role is corrected too. The password is never stored in a migration: the migrate
-- runner sets it from APP_DB_PASSWORD (see provisionAppRole).
alter role guildhall_app nosuperuser nobypassrls noinherit;
alter role guildhall_app set statement_timeout = '15s';
alter role guildhall_app set idle_in_transaction_session_timeout = '30s';

grant usage on schema public to guildhall_app;

create table guilds (
  guild_id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 200),
  goal text not null check (length(goal) between 1 and 2000),
  created_at timestamptz not null default now()
);

alter table guilds enable row level security;
alter table guilds force row level security;

create policy guilds_tenant on guilds
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select, insert, update, delete on guilds to guildhall_app;

-- Founding has no tenant yet, so the app cannot insert the first row under its own context.
-- This owner-side function is the only door: it mints the id, sets the tenant setting
-- transaction-locally for its single insert, restores the caller's previous value, and returns the id.
create function found_guild(p_name text, p_goal text) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid := gen_random_uuid();
  v_prev text := coalesce(current_setting('app.guild_id', true), '');
begin
  perform set_config('app.guild_id', v_id::text, true);
  insert into guilds (guild_id, name, goal) values (v_id, p_name, p_goal);
  perform set_config('app.guild_id', v_prev, true);
  return v_id;
end
$$;

revoke all on function found_guild(text, text) from public;
grant execute on function found_guild(text, text) to guildhall_app;
