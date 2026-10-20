-- Config versions are immutable history. The only legal update is confirming a pending version
-- (pending -> applied); nothing else may change, for the app role and the owner alike. Not a
-- security-definer function: it runs with the caller's rights and only inspects the row.

create function guild_config_versions_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if old.status = 'pending' and new.status = 'applied'
     and new.guild_id = old.guild_id
     and new.version = old.version
     and new.kind = old.kind
     and new.change = old.change
     and new.base_version is not distinct from old.base_version
     and new.config = old.config
     and new.created_at = old.created_at then
    return new;
  end if;
  raise exception 'guild_config_versions: only pending -> applied is allowed'
    using errcode = 'check_violation';
end;
$$;

revoke all on function guild_config_versions_guard() from public;

create trigger guild_config_versions_guard
  before update on guild_config_versions
  for each row execute function guild_config_versions_guard();
