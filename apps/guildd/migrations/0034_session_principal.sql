-- Session principal (#47): a session resolves to a member (id + role), not just a guild. The role
-- is server-side state in guild_members, never taken from the request. In this slice the Guild
-- Master is the only human member, and their member id is minted once, in the founding
-- transaction, so it is stable for the life of the guild.

create table guild_members (
  guild_id uuid not null references guilds (guild_id),
  member_id uuid not null,
  role text not null check (role in ('guild_master')),
  created_at timestamptz not null default now(),
  primary key (guild_id, member_id)
);

-- One Guild Master per guild, so a session's principal cannot be ambiguous.
create unique index guild_members_one_guild_master on guild_members (guild_id)
  where role = 'guild_master';

alter table guild_members enable row level security;
alter table guild_members force row level security;
create policy guild_members_tenant on guild_members
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select on guild_members to guildhall_app;

alter table identity_sessions add column member_id uuid;

-- Existing guilds get their Guild Master, and their live sessions point at them.
-- THE MIGRATOR MUST BYPASS RLS (a superuser, or a role with BYPASSRLS): `guilds` has forced RLS,
-- so without the bypass the loop below would see no guilds and silently mint nothing, locking
-- every existing guild out. `row_security = off` makes a non-bypass migrator fail loudly instead,
-- and the check after the loop fails the migration if any guild still lacks a Guild Master.
set local row_security = off;

do $$
declare
  rec record;
  v_member uuid;
begin
  for rec in select guild_id from guilds loop
    perform set_config('app.guild_id', rec.guild_id::text, true);
    v_member := gen_random_uuid();
    insert into guild_members (guild_id, member_id, role) values (rec.guild_id, v_member, 'guild_master');
    update identity_sessions set member_id = v_member where guild_id = rec.guild_id;
  end loop;
  perform set_config('app.guild_id', '', true);
  if exists (
    select 1 from guilds g
    where not exists (
      select 1 from guild_members m where m.guild_id = g.guild_id and m.role = 'guild_master'
    )
  ) then
    raise exception '0034: a guild has no Guild Master after the backfill (migrator must bypass RLS)';
  end if;
end
$$;

reset row_security;

alter table identity_sessions alter column member_id set not null;
alter table identity_sessions add constraint identity_sessions_member_fkey
  foreign key (guild_id, member_id) references guild_members (guild_id, member_id);

-- Founding mints the Guild Master in the same transaction as the guild row (still the only
-- tenantless write; same security-definer shape as 0003, one more insert).
create or replace function found_guild(p_name text, p_goal text) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid := gen_random_uuid();
  v_prev text := coalesce(current_setting('app.guild_id', true), '');
begin
  perform set_config('app.guild_id', v_id::text, true);
  insert into guilds (guild_id, name, goal) values (v_id, p_name, p_goal);
  insert into guild_members (guild_id, member_id, role)
    values (v_id, gen_random_uuid(), 'guild_master');
  perform append_event('guild.founded', jsonb_build_object('name', p_name, 'goal', p_goal));
  perform set_config('app.guild_id', v_prev, true);
  return v_id;
end
$$;
