-- Event log and transactional outbox. Every state change appends one event in the SAME transaction
-- as the change, with a per-guild monotonic, gap-free seq. Append-only is enforced by the database.

-- One counter row per guild. append_event locks it for the rest of the transaction, so concurrent
-- appenders for a guild serialise and a rollback gives the seq back (no gaps).
create table guild_event_counters (
  guild_id uuid primary key,
  last_seq bigint not null check (last_seq >= 0)
);

create table events (
  guild_id uuid not null,
  seq bigint not null check (seq >= 1),
  type text not null check (length(type) between 1 and 200),
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  primary key (guild_id, seq)
);

alter table guild_event_counters enable row level security;
alter table guild_event_counters force row level security;
alter table events enable row level security;
alter table events force row level security;

create policy guild_event_counters_tenant on guild_event_counters
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

create policy events_tenant on events
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

-- The app may only read events; it appends through append_event, so it cannot choose a seq.
-- It gets no privilege at all on the counters. No update or delete is granted on events.
grant select on events to guildhall_app;

-- Defence in depth: even the owner cannot rewrite history.
create function events_reject_change() returns trigger language plpgsql as $$
begin
  raise exception 'events is append-only' using errcode = 'restrict_violation';
end
$$;

create trigger events_append_only before update or delete on events
  for each row execute function events_reject_change();
create trigger events_no_truncate before truncate on events
  for each statement execute function events_reject_change();

-- Security definer because the app has no write privilege on the counters or events; it is bound
-- to the caller's tenant context (app.guild_id) and refuses to run without one.
create function append_event(p_type text, p_payload jsonb default '{}'::jsonb) returns bigint
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_guild uuid := nullif(current_setting('app.guild_id', true), '')::uuid;
  v_seq bigint;
begin
  if v_guild is null then
    raise exception 'append_event requires a guild context';
  end if;
  insert into guild_event_counters (guild_id, last_seq) values (v_guild, 1)
    on conflict (guild_id) do update set last_seq = guild_event_counters.last_seq + 1
    returning last_seq into v_seq;
  insert into events (guild_id, seq, type, payload) values (v_guild, v_seq, p_type, p_payload);
  return v_seq;
end
$$;

revoke all on function append_event(text, jsonb) from public;
grant execute on function append_event(text, jsonb) to guildhall_app;

-- Founding emits guild.founded (seq 1) in the same transaction as the guild row.
create or replace function found_guild(p_name text, p_goal text) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid := gen_random_uuid();
  v_prev text := coalesce(current_setting('app.guild_id', true), '');
begin
  perform set_config('app.guild_id', v_id::text, true);
  insert into guilds (guild_id, name, goal) values (v_id, p_name, p_goal);
  perform append_event('guild.founded', jsonb_build_object('name', p_name, 'goal', p_goal));
  perform set_config('app.guild_id', v_prev, true);
  return v_id;
end
$$;
