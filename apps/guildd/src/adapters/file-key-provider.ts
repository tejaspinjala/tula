import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { DerivedKeyProvider } from './derived-key-provider'

const keyFile = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{64}$/)

/**
 * Local-file adapter for {@link KeyProvider}: the master secret is 64 hex chars in a file created
 * with mode 0600, outside Postgres. Development and single-host use; the Keychain or a KMS can
 * replace it behind the same port.
 */
export class FileKeyProvider extends DerivedKeyProvider {
  /**
   * Opens the key file, creating it with a fresh random master when absent. Never overwrites an
   * existing file: a corrupt one throws, so keys are not silently rotated away.
   */
  static async open(path: string): Promise<FileKeyProvider> {
    await mkdir(dirname(path), { recursive: true })
    try {
      const handle = await open(path, 'wx', 0o600)
      try {
        const fresh = crypto.getRandomValues(new Uint8Array(32))
        await handle.writeFile(Buffer.from(fresh).toString('hex'))
      } finally {
        await handle.close()
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
        throw error
      }
    }
    const hex = keyFile.parse(await readFile(path, 'utf8'))
    return new FileKeyProvider(Uint8Array.fromHex(hex))
  }
}
