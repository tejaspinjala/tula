import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
