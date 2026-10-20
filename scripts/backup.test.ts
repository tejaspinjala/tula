import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertKeySeparated } from './backup-restore'

test('key directory inside the backup directory, or the reverse, is rejected', () => {
  expect(() => assertKeySeparated('/data/backups', '/data/backups/keys')).toThrow()
  expect(() => assertKeySeparated('/data/backups', '/data/backups')).toThrow()
  expect(() => assertKeySeparated('/data/keys/backups', '/data/keys')).toThrow()
})

test('a sibling directory sharing a name prefix is allowed', () => {
  expect(() => assertKeySeparated('/data/backups', '/data/backups-keys')).not.toThrow()
  expect(() => assertKeySeparated('/data/backups', '/elsewhere/keys')).not.toThrow()
})

test('backup rejects overlapping directories before creating any output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'backup-guard-'))
  const backupDir = join(root, 'backups')
  const proc = Bun.spawn(['bun', join(import.meta.dir, 'backup.ts')], {
    env: {
      ...process.env,
      BACKUP_DIR: backupDir,
      BACKUP_KEY_DIR: join(backupDir, 'keys'),
      KEY_FILE: join(root, 'master.key'),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(await proc.exited).not.toBe(0)
  expect(existsSync(backupDir)).toBe(false)
})
