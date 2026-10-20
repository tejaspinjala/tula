-- append_event now refuses a tenant context whose guild does not exist, so a forged or stale
-- app.guild_id can never mint a counter row and events for a phantom guild. Still security
-- definer (the app has no write privilege on counters or events), still bound to app.guild_id.
create or replace function append_event(p_type text, p_payload jsonb default '{}'::jsonb) returns bigint
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_guild uuid := nullif(current_setting('app.guild_id', true), '')::uuid;
  v_seq bigint;
begin
  if v_guild is null then
    raise exception 'append_event requires a guild context';
  end if;
  if not exists (select 1 from guilds where guild_id = v_guild) then
    raise exception 'append_event: guild % does not exist', v_guild;
  end if;
  insert into guild_event_counters (guild_id, last_seq) values (v_guild, 1)
    on conflict (guild_id) do update set last_seq = guild_event_counters.last_seq + 1
    returning last_seq into v_seq;
  insert into events (guild_id, seq, type, payload) values (v_guild, v_seq, p_type, p_payload);
  return v_seq;
end
$$;
