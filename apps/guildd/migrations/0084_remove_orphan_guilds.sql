-- Orphan guilds (ticket #197): before founding became one transaction with the first passkey, an
-- abandoned passkey prompt left a guild with no credential. An orphan is a guild older than
-- p_min_age with no passkey whose only events are the ones founding itself writes. A guild with a
-- passkey, or with any other event, is never an orphan.
--
-- Both functions touch every guild, so they run with row security off: a migrator subject to RLS
-- fails loudly instead of seeing no rows (see 0034 and .claude/rules/tenancy.md). They are
-- owner-only: the app role gets no execute.

create function orphan_guild_ids(p_min_age interval default interval '1 hour')
returns setof uuid language plpgsql stable as $$
begin
  if not exists (select 1 from pg_roles where rolname = current_user and (rolsuper or rolbypassrls)) then
    raise exception 'orphan_guild_ids: row-level security would hide guilds from this role';
  end if;
  return query
    select g.guild_id from guilds g
    where g.created_at < now() - p_min_age
      and not exists (select 1 from identity_credentials c where c.guild_id = g.guild_id)
      and not exists (
        select 1 from events e
        where e.guild_id = g.guild_id
          and e.type not in ('guild.founded', 'identity.founding_token_issued', 'config.seeded'))
    order by g.guild_id;
end
$$;

-- Removes every orphan guild with all its rows (every table carrying a guild_id), including its
-- founding events and audit chain entries, which are append-only for everyone else: the guards
-- are lifted for this one statement set and restored before it returns.
-- @returns how many guilds were removed.
create function remove_orphan_guilds(p_min_age interval default interval '1 hour')
returns integer language plpgsql as $$
declare
  v_ids uuid[] := array(select orphan_guild_ids(p_min_age));
  v_tables text[];
  v_pending text[];
  v_left text[];
  v_table text;
  v_progress boolean;
begin
  if coalesce(array_length(v_ids, 1), 0) = 0 then
    return 0;
  end if;
  select array_agg(c.oid::regclass::text order by c.relname) into v_tables
  from pg_class c
  join pg_attribute a on a.attrelid = c.oid and a.attname = 'guild_id' and not a.attisdropped
  where c.relkind = 'r' and c.relnamespace = current_schema()::regnamespace
    and c.relname <> 'guilds';
  foreach v_table in array v_tables loop
    execute format('alter table %s disable trigger user', v_table);
  end loop;
  v_pending := v_tables;
  while coalesce(array_length(v_pending, 1), 0) > 0 loop
    v_progress := false;
    v_left := '{}';
    foreach v_table in array v_pending loop
      begin
        execute format('delete from %s where guild_id = any ($1)', v_table) using v_ids;
        v_progress := true;
      exception when foreign_key_violation then
        v_left := v_left || v_table;
      end;
    end loop;
    if not v_progress then
      raise exception 'remove_orphan_guilds: foreign keys block %', v_left;
    end if;
    v_pending := v_left;
  end loop;
  delete from guilds where guild_id = any (v_ids);
  foreach v_table in array v_tables loop
    execute format('alter table %s enable trigger user', v_table);
  end loop;
  return array_length(v_ids, 1);
end
$$;

revoke all on function orphan_guild_ids(interval) from public;
revoke all on function remove_orphan_guilds(interval) from public;

select remove_orphan_guilds();
