-- Usernameless passkey sign-in (ticket #69): the Guild Master signs in with a discoverable
-- credential and no guild id, so the guild must be found from the asserted credential id, and
-- the challenge must be stored before any guild is known.
--
-- guild_for_credential: forced RLS on `identity_credentials` hides every row from a caller with
-- no tenant. This owner-side function (security definer, so it runs with the migrator's BYPASSRLS)
-- answers one narrow question: which guild holds this credential id. It returns a bare uuid, or
-- null when the id is unknown or (never expected, the id is random) held by more than one guild;
-- no key, counter or other column crosses the tenant boundary. The search path is pinned, every
-- name is schema-qualified, and only the app role may execute it.
create function guild_for_credential(p_credential_id text) returns uuid
  language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select case when count(*) = 1 then min(guild_id::text)::uuid end
  from public.identity_credentials
  where credential_id = p_credential_id
$$;

revoke all on function guild_for_credential(text) from public;
grant execute on function guild_for_credential(text) to guildhall_app;

-- Deliberately NOT a tenant table: no guild_id column, no row level security. A usernameless
-- begin has no guild, so its one-use challenge cannot be scoped to one. It holds only an opaque
-- id, the random challenge and its expiry, never guild data. Rows are single-use (deleted when
-- taken) and expired rows are deleted on every insert. Exempt in src/testing/rls-check.ts
-- (NOT_TENANT).
create table signin_challenges (
  challenge_id uuid primary key,
  challenge text not null,
  expires_at timestamptz not null
);
create index signin_challenges_expiry on signin_challenges (expires_at);

grant select, insert, delete on signin_challenges to guildhall_app;
