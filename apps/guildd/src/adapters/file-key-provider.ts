import { link, mkdir, open, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { DerivedKeyProvider } from './derived-key-provider'

const keyFile = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{64}$/)

/** Whether `error` is a Node filesystem error with the given code. */
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

/**
 * Local-file adapter for {@link KeyProvider}: the master secret is 64 hex chars in a file that only
 * its owner may access (directory 0700, file 0600), outside Postgres. Development and single-host
 * use; the Keychain or a KMS can replace it behind the same port.
 */
export class FileKeyProvider extends DerivedKeyProvider {
  /**
   * Opens the key file, creating it with a fresh random master when absent. The file appears
   * atomically (written to a private temp file, then hard-linked into place), so a concurrent or
   * crashed open never sees a half-written key. It never overwrites an existing file: a corrupt
   * one throws, so keys are not silently rotated away, and so does one that group or others can
   * access. With `create: false` (production) a missing file throws and nothing is created, so a
   * lost key never silently becomes a new one that orphans the audit chain and the vault.
   */
  static async open(path: string, options: { create?: boolean } = {}): Promise<FileKeyProvider> {
    if (options.create ?? true) {
      await FileKeyProvider.create(path)
    }
    const handle = await open(path, 'r')
    try {
      if (((await handle.stat()).mode & 0o077) !== 0) {
        throw new Error(`key file ${path} must be accessible by its owner only (mode 0600)`)
      }
      const hex = keyFile.parse(await handle.readFile('utf8'))
      return new FileKeyProvider(Uint8Array.fromHex(hex))
    } finally {
      await handle.close()
    }
  }

  /** Atomically creates the key file with a fresh master unless one already exists. */
  private static async create(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temp = `${path}.${crypto.randomUUID()}.tmp`
    const fresh = await open(temp, 'wx', 0o600)
    try {
      await fresh.writeFile(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'))
    } finally {
      await fresh.close()
    }
    try {
      await link(temp, path)
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) {
        throw error
      }
    } finally {
      await unlink(temp)
    }
  }
}
