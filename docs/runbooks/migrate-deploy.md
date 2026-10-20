# Migrating a deployment

Migrations run as a dedicated migrator role; the app connects as `guildhall_app`, which is never
superuser and never has `BYPASSRLS`.

## The migrator needs BYPASSRLS

Migration 0034 (session principal) backfills a Guild Master for every existing guild. `guilds` has
forced row level security, so the backfill needs a role that bypasses it. A non-superuser role with
`BYPASSRLS` is enough and preferred over a superuser.

```sql
create role guildhall_migrator login password '<secret>' bypassrls;
grant all privileges on database guildhall to guildhall_migrator;
grant all privileges on schema public to guildhall_migrator;
```

If the migrator is the existing database owner, run `alter role <owner> bypassrls;` instead.

## Running it

```sh
DATABASE_URL=postgres://guildhall_migrator:<secret>@<host>:5432/guildhall \
APP_DB_PASSWORD=<app password> bun run db:migrate
```

## The loud 0034 failure

0034 sets `row_security = off`. Without `BYPASSRLS` Postgres refuses with
`query would be affected by row-level security policy`, and the migration aborts and rolls back
rather than minting nothing. It also fails if any guild still lacks a Guild Master after the
backfill. Fix: grant `BYPASSRLS` to the migrator and rerun `bun run db:migrate`; nothing was applied.
