# Backup and restore

What is backed up, where it goes, and how to bring a scratch stack back. Ticket #33.

## What is backed up

| Thing | How | Where |
| --- | --- | --- |
| Postgres | `pg_dump -Fc` (custom format) | `guildhall.dump` |
| Object storage (MinIO) | every object copied, SHA-256 in `manifest.json` | `objects/<guild>/<hash>` |
| **KEY_FILE master key** | file copy, mode 0600 | a **separate** directory, `master.key` |

The master key is not in Postgres or in the object store. **Without it the audit chain cannot be
verified and the vault cannot be decrypted**, so a database backup alone is not a recoverable
backup. Keep the key backup somewhere other than the data backup (another disk, a password manager
or a sealed offline copy), and never in the same directory or bucket. `bun run backup` refuses a
`BACKUP_KEY_DIR` inside `BACKUP_DIR` (or the reverse) before it writes anything.

**Encrypt before the backup leaves the host.** The dump and the copied objects are plaintext
apart from vault ciphertext, so they expose guild data. Encrypt the backup directory (`age` or
`gpg`) before copying it off the host; the key backup is raw and must be stored securely too.

## Scheduled backups

`docker compose --profile backup up -d` starts `backup-postgres` (a dump every
`BACKUP_INTERVAL_SECONDS`, default 86400, keeping `BACKUP_KEEP`, default 14) and `backup-objects`
(`mc mirror` of the bucket), both into the `backup-data` volume. These services never see the key.
Copy the volume off the host as part of your normal host backup.

## One-off backup

```sh
DATABASE_URL=postgres://guildhall:guildhall@localhost:5432/guildhall \
KEY_FILE=.guildhall/master.key BACKUP_KEY_DIR=/safe/place/keys \
bun run backup            # writes .guildhall/backups/<timestamp>/
```

Postgres tools run inside the Postgres container found by its published port (set `PG_CONTAINER`
to override), so Docker must be reachable.

## Restore into a scratch stack

A restore never touches an existing database: it creates a new one and a new bucket.

```sh
bun run restore .guildhall/backups/<timestamp> guildhall_scratch guildhall-scratch \
  /safe/place/keys/<timestamp> .guildhall/scratch.key
```

It verifies every hash in the manifest before writing anything and drops the half-built database
on failure. The cluster must already have the `guildhall_app` role (any cluster that ever ran
`bun run db:migrate` does); on a brand new cluster run the migrations first. To use the restored
data, start guildd with `DATABASE_URL` naming the new database, `OBJECT_STORE_BUCKET` the new
bucket, and `KEY_FILE` the restored key. Delete the scratch database and bucket when done.

## The drill

`scripts/backup-restore.integration.ts` (run by `bun run test:integration`, which needs the compose
stack) proves the restore: it seeds a guild with events, a note and an artifact in a throwaway
database and bucket, backs up, restores into a second throwaway database and bucket with the key
from its separate backup, then checks the event count, that the audit chain verifies intact, that
the known note is present and that the artifact bytes hash to the same SHA-256. It drops every
database, bucket and temp directory it created, pass or fail.

Run it with the port overrides when 5432 is taken:

```sh
POSTGRES_PORT=55432 DATABASE_URL=postgres://guildhall:guildhall@localhost:55432/guildhall \
  bun run test:integration
```

Run the drill after any change to migrations or to the audit chain, and record its commands and exit
codes on the ticket.
