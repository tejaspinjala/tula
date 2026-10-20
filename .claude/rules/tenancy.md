---
paths:
  - apps/guildd/src/db/**
  - '**/migrations/**'
  - '**/*.sql'
---

# Tenancy rules

- Every tenant table has `guild_id uuid not null`, `ENABLE` and `FORCE ROW LEVEL SECURITY`, and at
  least one policy (`using` and `with check`) comparing `guild_id` to
  `nullif(current_setting('app.guild_id', true), '')::uuid`. Only `schema_migrations`, `rate_limits` (opaque client/guild-keyed counters, see migration 0016) and `push_guilds` (opaque guild ids only; select and insert grants, no delete) `global_gate` (the single-row global Bar the Gates: opaque ids only, see migration 0043) and `signin_challenges` (usernameless sign-in challenges: opaque id, random challenge and expiry, single-use, see migration 0057) are exempt. Five security-definer functions cross tenants, three for a global Bar the Gates, one for the founding lock and one for usernameless sign-in, all with a pinned `search_path`, schema-qualified names and execute granted only to `guildhall_app`: `list_guild_ids` (0043, recreated in 0046) enumerates every guild id, so the app role can list all guilds' opaque ids (exposure: ids only, no names or data, and only the global bar's announcement uses it); `revoke_all_run_tokens` (0046) revokes every guild's run tokens in one statement and returns a count; `release_all_leases(reason)` (0050, reason checked against the FailReason list in 0051) returns every guild's active Quests to queued (lease cleared, deliverable at once, `reason` as last error) in one statement and returns a count, so a global bar's cost does not grow with the number of guilds (no per-guild advisory lock; the single update locks the rows it changes). It is exposed as `QuestQueue.releaseAllLeases`. The fourth, `any_guild_exists()` (0056), returns a bare boolean (no id, name or count) so `FOUNDING_MODE=once` can refuse a second founding; it is read only inside the founding transaction, under a transaction-scoped advisory lock (`GET /founding` reads it too, to answer `{ open }`). The fifth, `guild_for_credential(credential_id)` (0057), returns one guild uuid or null so a discoverable-credential sign-in with no guild id can find the guild; nothing else about the credential crosses the boundary, and the assertion is then verified exactly as the per-guild path does.
- `identity_credentials (credential_id)` is unique across guilds (migration 0058), the one cross-tenant unique index allowed: credential ids are random 16+ byte values the authenticator picks, so it reveals nothing beyond "taken", it makes `guild_for_credential` an index lookup, and it stops one guild registering another's id (refused as `credential_exists`).
- Primary keys, unique constraints and foreign keys on tenant tables include `guild_id`, so no
  constraint can reveal another guild's rows.
- Migrations run as the owner; the app connects as `guildhall_app` (non-owner, no bypass-RLS).
  The migrator must have `BYPASSRLS` (a non-superuser role with it is fine; migration 0034 backfills
  under forced RLS and fails loudly without it). `guildhall_app` never has it. See
  `docs/runbooks/migrate-deploy.md`.
  The app password is set from `APP_DB_PASSWORD` by the migrate runner, never in a migration.
  Grant it table privileges explicitly in the same migration that creates the table.
- Tenant context is `set_config('app.guild_id', ..., true)` (transaction-local), set only by
  `Db.withGuild`. App code reaches tenant tables only through that helper; never `set` / `set_config(..., false)`.
- The only tenantless write is founding, via the security-definer `found_guild` function. Any new
  such function needs a JSDoc/SQL comment saying why, `set search_path`, and a revoke from public.
- Every new route that touches tenant data gets an `expectGuildIsolation` probe
  (`src/testing/cross-guild.ts`); `src/db/schema.rls.test.ts` fails any table missing the above.
- Contract tests use real Postgres (`docker compose up -d`; `DATABASE_URL` is the owner URL). There
  is no memory adapter for `Db`.
- Never edit a migration already on `develop`; add a new one.
