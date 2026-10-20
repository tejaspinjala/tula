import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type AnchoredCheckpoint,
  anchoredCheckpoint,
  type CheckpointAnchor,
} from '../ports/checkpoint-anchor'
import { assertGuildId } from '../ports/object-store'

/**
 * {@link CheckpointAnchor} over append-only JSON-lines files, one per guild, in a directory that
 * must live outside the Postgres host's reach (another volume or machine). Appends are single
 * `O_APPEND` writes, so concurrent publishes never interleave.
 */
export class FileCheckpointAnchor implements CheckpointAnchor {
  constructor(private readonly dir: string) {}

  private fileFor(guildId: string): string {
    assertGuildId(guildId)
    return join(this.dir, `${guildId}.jsonl`)
  }

  async publish(guildId: string, checkpoint: AnchoredCheckpoint): Promise<void> {
    const file = this.fileFor(guildId)
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    await appendFile(file, `${JSON.stringify(checkpoint)}\n`, { mode: 0o600 })
  }

  async latest(guildId: string): Promise<AnchoredCheckpoint | null> {
    const file = this.fileFor(guildId)
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return null
      }
      throw error
    }
    let best: AnchoredCheckpoint | null = null
    for (const line of text.split('\n')) {
      if (line === '') {
        continue
      }
      const parsed = anchoredCheckpoint.parse(JSON.parse(line))
      if (!best || parsed.seq > best.seq) {
        best = parsed
      }
    }
    return best
  }
}
