-- A credential id is a random 16+ byte value the authenticator picks, so a collision between two
-- real passkeys does not happen. Making it unique ACROSS guilds (the one cross-tenant unique index
-- allowed: it reveals only that an id is taken, and registration refuses a taken id with
-- `credential_exists`) does two things for usernameless sign-in (migration 0057):
--   * guild_for_credential becomes an index lookup instead of a scan of every guild's credentials
--     on a public route;
--   * no guild can register another guild's credential id and so null that guild's sign-in.
create unique index identity_credentials_credential_id_key on identity_credentials (credential_id);

-- With the index, at most one row matches, so the "held by several guilds" branch is gone.
create or replace function guild_for_credential(p_credential_id text) returns uuid
  language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select guild_id from public.identity_credentials where credential_id = p_credential_id
$$;
