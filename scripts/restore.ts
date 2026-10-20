/**
 * Restores a backup into a NEW database and bucket (never over live data).
 * Usage: `bun run restore <backup-dir> <new-database> <new-bucket> [key-backup-dir new-key-path]`.
 */
import { resolve } from 'node:path'
import { restore, restoreKey } from './backup-restore'

if (import.meta.main) {
  const [inDir, database, bucket, keyDir, keyPath] = process.argv.slice(2)
  if (!inDir || !database || !bucket) {
    throw new Error('usage: restore <backup-dir> <new-database> <new-bucket> [key-dir key-path]')
  }
  await restore({
    databaseUrl:
      process.env.DATABASE_URL ?? 'postgres://guildhall:guildhall@localhost:5432/guildhall',
    endpoint: process.env.OBJECT_STORE_ENDPOINT ?? 'http://localhost:9000',
    accessKeyId: process.env.OBJECT_STORE_ACCESS_KEY ?? 'guildhall',
    secretAccessKey: process.env.OBJECT_STORE_SECRET_KEY ?? 'guildhall-dev-secret',
    database,
    bucket,
    inDir: resolve(inDir),
  })
  console.log(`restored into database ${database} and bucket ${bucket}`)
  if (keyDir && keyPath) {
    await restoreKey(resolve(keyDir), resolve(keyPath))
    console.log(`master key restored to ${resolve(keyPath)}`)
  }
}
