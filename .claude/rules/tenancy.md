---
paths:
  - apps/guildd/src/db/**
  - '**/migrations/**'
  - '**/*.sql'
---

# Tenancy rules

- Every tenant table has `guild_id uuid not null`, `ENABLE` and `FORCE ROW LEVEL SECURITY`, and at
  least one policy (`using` and `with check`) comparing `guild_id` to
  `nullif(current_setting('app.guild_id', true), '')::uuid`. Only `schema_migrations`, `rate_limits` (opaque client/guild-keyed counters, see migration 0016) and `push_guilds` (opaque guild ids only; select and insert grants, no delete) and `global_gate` (the single-row global Bar the Gates: opaque ids only, see migration 0043) are exempt. Migration 0043 also adds the security-definer `list_guild_ids` (opaque ids only, so a global bar can revoke every guild's run tokens).
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
