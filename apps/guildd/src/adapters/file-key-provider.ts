import { type FileHandle, link, mkdir, open, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { DerivedKeyProvider } from './derived-key-provider'

const keyFile = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{64}$/)

/** Writes the master secret into the freshly created temp file; replaceable so tests can fail it. */
type KeyWriter = (handle: FileHandle) => Promise<void>

const writeFreshKey: KeyWriter = (handle) =>
  handle.writeFile(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'))

/** Whether `error` is a Node filesystem error with the given code. */
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

/**
 * Local-file adapter for {@link KeyProvider}: the master secret is 64 hex chars in a file that only
 * its owner may access (directory 0700, file 0600), outside Postgres. Development and single-host
 * use; the Keychain or a KMS can replace it behind the same port.
 *
 * Requires a filesystem that supports hard links (`link(2)`) in the key directory: the file is
 * published by hard-linking a private temp file, which is what makes creation atomic. Filesystems
 * without hard links (some network and FAT-style mounts) are not supported and `open` fails there.
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
  static async open(
    path: string,
    options: { create?: boolean; writeKey?: KeyWriter } = {}
  ): Promise<FileKeyProvider> {
    if (options.create ?? true) {
      await FileKeyProvider.create(path, options.writeKey ?? writeFreshKey)
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
  private static async create(path: string, writeKey: KeyWriter): Promise<void> {
    const dir = dirname(path)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    if (((await stat(dir)).mode & 0o077) !== 0) {
      throw new Error(`key directory ${dir} must be accessible by its owner only (mode 0700)`)
    }
    const temp = `${path}.${crypto.randomUUID()}.tmp`
    const fresh = await open(temp, 'wx', 0o600)
    try {
      await writeKey(fresh)
    } catch (error) {
      await unlink(temp)
      throw error
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
