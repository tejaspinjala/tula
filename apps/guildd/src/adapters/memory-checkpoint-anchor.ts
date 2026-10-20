import type { AnchoredCheckpoint, CheckpointAnchor } from '../ports/checkpoint-anchor'
import { assertGuildId } from '../ports/object-store'

/** In-memory {@link CheckpointAnchor} for tests and local runs; state lives only in the instance. */
export class MemoryCheckpointAnchor implements CheckpointAnchor {
  private readonly heads = new Map<string, AnchoredCheckpoint>()

  async publish(guildId: string, checkpoint: AnchoredCheckpoint): Promise<void> {
    assertGuildId(guildId)
    const head = this.heads.get(guildId)
    if (!head || head.seq < checkpoint.seq) {
      this.heads.set(guildId, { ...checkpoint })
    }
  }

  async latest(guildId: string): Promise<AnchoredCheckpoint | null> {
    assertGuildId(guildId)
    const head = this.heads.get(guildId)
    return head ? { ...head } : null
  }
}
