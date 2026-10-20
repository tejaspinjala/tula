import {
  type Missive,
  type MissivePage,
  type MissiveQuery,
  type MissiveStore,
  type NewMissive,
  type SendResult,
  WHOLE_HALL,
} from '../ports/missive-store'

interface Stored {
  missive: Missive
  /** Quest and attempt-scoped identity of the send, for idempotency. */
  key: string
  sentAtMs: number
}

/**
 * Memory adapter for {@link MissiveStore}: state in this instance only; `send` checks and writes
 * with no await between, so same-tick repeats cannot both insert.
 */
export class MemoryMissiveStore implements MissiveStore {
  private readonly guilds = new Map<string, Stored[]>()
  private nextSeq = 1

  private missives(guildId: string): Stored[] {
    let all = this.guilds.get(guildId)
    if (!all) {
      all = []
      this.guilds.set(guildId, all)
    }
    return all
  }

  async send(guildId: string, input: NewMissive): Promise<SendResult> {
    const all = this.missives(guildId)
    const key = JSON.stringify([input.questId, input.attempt, input.from, input.to, input.text])
    const prior = all.find((s) => s.key === key)
    if (prior) {
      return { ok: true, missive: prior.missive, created: false }
    }
    if (all.filter((s) => s.missive.questId === input.questId).length >= input.maxPerQuest) {
      return { ok: false, error: 'missive_cap' }
    }
    const missive: Missive = {
      seq: this.nextSeq++,
      id: crypto.randomUUID(),
      hallId: input.hallId,
      questId: input.questId,
      from: input.from,
      to: input.to,
      text: input.text,
      sentAt: input.at.toISOString(),
    }
    all.push({ missive, key, sentAtMs: input.at.getTime() })
    return { ok: true, missive, created: true }
  }

  async list(guildId: string, query: MissiveQuery): Promise<MissivePage> {
    const visible = this.missives(guildId)
      .filter(
        (s) =>
          s.missive.hallId === query.hallId &&
          (query.member === undefined ||
            s.missive.from === query.member ||
            s.missive.to === query.member ||
            s.missive.to === WHOLE_HALL) &&
          (query.since === undefined || s.sentAtMs > query.since.getTime()) &&
          (query.after === undefined || s.missive.seq < query.after)
      )
      .map((s) => s.missive)
      .sort((a, b) => b.seq - a.seq)
    const page = visible.slice(0, query.limit)
    const last = page.at(-1)
    return {
      missives: page,
      next: visible.length > page.length && last ? last.seq : null,
    }
  }
}
