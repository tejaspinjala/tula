/**
 * Backs up the stack to a timestamped directory under BACKUP_DIR (default `.guildhall/backups`):
 * a Postgres custom-format dump and a copy of the object-store bucket. With KEY_FILE set, the master
 * key is copied to BACKUP_KEY_DIR, which must differ from BACKUP_DIR: the key must not travel with
 * the data it protects. Usage: `bun run backup`.
 */
import { join, resolve } from 'node:path'
import { assertKeySeparated, backup, backupKey } from './backup-restore'

const env = {
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://guildhall:guildhall@localhost:5432/guildhall',
  endpoint: process.env.OBJECT_STORE_ENDPOINT ?? 'http://localhost:9000',
  accessKeyId: process.env.OBJECT_STORE_ACCESS_KEY ?? 'guildhall',
  secretAccessKey: process.env.OBJECT_STORE_SECRET_KEY ?? 'guildhall-dev-secret',
  bucket: process.env.OBJECT_STORE_BUCKET ?? 'guildhall-artifacts',
}

if (import.meta.main) {
  const backupDir = resolve(process.env.BACKUP_DIR ?? '.guildhall/backups')
  const keyFile = process.env.KEY_FILE
  const keyDir = process.env.BACKUP_KEY_DIR
  if (keyFile && keyDir) {
    assertKeySeparated(backupDir, keyDir)
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = join(backupDir, stamp)
  const database = new URL(env.databaseUrl).pathname.slice(1) || 'guildhall'
  await backup({ ...env, database, outDir })
  console.log(`backup written to ${outDir}`)
  if (keyFile && keyDir) {
    await backupKey(keyFile, join(resolve(keyDir), stamp))
    console.log(`master key copied to ${join(resolve(keyDir), stamp)}`)
  } else {
    console.warn('KEY_FILE and BACKUP_KEY_DIR not both set: the master key was NOT backed up')
  }
}
