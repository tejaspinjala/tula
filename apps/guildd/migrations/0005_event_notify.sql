-- Wake live event streams: append_event also notifies the 'guild_events' channel with the guild id.
-- The notification is delivered on commit only, so a rolled-back append wakes nobody. The payload
-- carries no tenant data beyond the id; listeners then read through withGuild (row-level security).
create or replace function append_event(p_type text, p_payload jsonb default '{}'::jsonb) returns bigint
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
  perform pg_notify('guild_events', v_guild::text);
  return v_seq;
end
$$;
