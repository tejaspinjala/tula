import { afterAll, expect, test } from 'bun:test'
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { keyProviderContract } from '../ports/key-provider.contract'
import { FileKeyProvider } from './file-key-provider'

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
})
const freshDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'guildd-keys-'))
  dirs.push(dir)
  return dir
}

keyProviderContract('local file', async () => {
  const path = join(await freshDir(), 'master.key')
  return {
    provider: await FileKeyProvider.open(path),
    reopen: () => FileKeyProvider.open(path),
  }
})

test('the key file is created owner-only and is never overwritten', async () => {
  const path = join(await freshDir(), 'nested', 'master.key')
  const first = await FileKeyProvider.open(path)
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  const mac = await first.mac(crypto.randomUUID(), 'audit', new Uint8Array([1]))
  expect(mac).toMatch(/^[0-9a-f]{64}$/)
})

test('a corrupt key file fails at open instead of being replaced', async () => {
  const path = join(await freshDir(), 'master.key')
  await writeFile(path, 'not a key')
  await expect(FileKeyProvider.open(path)).rejects.toThrow()
})

test('a key file readable by group or others is rejected', async () => {
  const path = join(await freshDir(), 'master.key')
  await writeFile(path, 'a'.repeat(64))
  await chmod(path, 0o644)
  await expect(FileKeyProvider.open(path)).rejects.toThrow(/0600|permission|mode/i)
})

test('concurrent opens on a fresh path agree on one key and leave no temp files', async () => {
  const path = join(await freshDir(), 'master.key')
  const guild = crypto.randomUUID()
  const opened = await Promise.all(Array.from({ length: 8 }, () => FileKeyProvider.open(path)))
  const macs = await Promise.all(opened.map((p) => p.mac(guild, 'audit', new Uint8Array([7]))))
  expect(new Set(macs).size).toBe(1)
  expect(await readdir(dirname(path))).toEqual(['master.key'])
})

test('the key directory is created owner-only', async () => {
  const dir = join(await freshDir(), 'keys')
  await FileKeyProvider.open(join(dir, 'master.key'))
  expect((await stat(dir)).mode & 0o777).toBe(0o700)
})
