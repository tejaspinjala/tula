import {
  type Handoff,
  type HandoffStore,
  hashHandoff,
  type StoredHandoff,
} from '../ports/handoff-store'

/**
 * Memory {@link HandoffStore}. Every operation checks and writes in one synchronous step, so it is
 * as atomic as the Postgres adapter. State lives in the instance.
 */
export class MemoryHandoffStore implements HandoffStore {
  private readonly handoffs = new Map<string, StoredHandoff>()
  private readonly artifacts = new Set<string>()

  /** `onEvent` receives each appended event's type and ids-and-hashes-only payload. */
  constructor(
    private readonly onEvent: (guildId: string, type: string, payload: object) => void = () => {}
  ) {}

  async record(
    guildId: string,
    questId: string,
    attempt: number,
    memberId: string,
    value: Handoff
  ): Promise<{ stored: StoredHandoff; created: boolean }> {
    const key = JSON.stringify([guildId, questId, attempt])
    const existing = this.handoffs.get(key)
    if (existing) {
      return { stored: existing, created: false }
    }
    const stored: StoredHandoff = { handoff: value, hash: hashHandoff(value), memberId }
    this.handoffs.set(key, stored)
    this.onEvent(guildId, 'handoff.recorded', {
      quest_id: questId,
      attempt,
      handoff_hash: stored.hash,
    })
    return { stored, created: true }
  }

  async get(guildId: string, questId: string, attempt: number): Promise<StoredHandoff | null> {
    return this.handoffs.get(JSON.stringify([guildId, questId, attempt])) ?? null
  }

  async attach(guildId: string, questId: string, hash: string, _size: number): Promise<void> {
    const key = JSON.stringify([guildId, questId, hash])
    if (!this.artifacts.has(key)) {
      this.artifacts.add(key)
      this.onEvent(guildId, 'artifact.attached', { quest_id: questId, hash })
    }
  }

  async holds(guildId: string, questId: string, hash: string): Promise<boolean> {
    return this.artifacts.has(JSON.stringify([guildId, questId, hash]))
  }
}
