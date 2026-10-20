import type { Clock } from '../ports/clock'
import {
  type NewSeal,
  SEAL_RESERVATION_MS,
  SEAL_TTL_MS,
  type Seal,
  type SealPage,
  type SealResult,
  type SealStatus,
  type SealStore,
} from '../ports/seal-store'

/** Memory adapter for {@link SealStore}: state in this instance only; every transition is synchronous. */
export class MemorySealStore implements SealStore {
  private readonly guilds = new Map<string, Map<string, Seal>>()

  constructor(private readonly clock: Clock) {}

  private seals(guildId: string): Map<string, Seal> {
    let seals = this.guilds.get(guildId)
    if (!seals) {
      seals = new Map()
      this.guilds.set(guildId, seals)
    }
    return seals
  }

  /** The Seal as read now: past-expiry requested reads expired, a lapsed reservation reads approved. */
  private read(seal: Seal): Seal {
    const now = this.clock.now().getTime()
    if (seal.status === 'requested' && Date.parse(seal.expiresAt) <= now) {
      return { ...seal, status: 'expired' }
    }
    if (seal.status === 'reserved' && seal.reservedUntil && Date.parse(seal.reservedUntil) <= now) {
      return { ...seal, status: 'approved', reservedUntil: null }
    }
    return { ...seal }
  }

  private write(guildId: string, seal: Seal, patch: Partial<Seal>): Seal {
    const next = { ...seal, ...patch }
    this.seals(guildId).set(seal.id, next)
    return { ...next }
  }

  // Every method checks and writes with no await between them, so same-tick calls cannot interleave.
  async request(guildId: string, input: NewSeal): Promise<Seal> {
    for (const existing of this.seals(guildId).values()) {
      if (existing.questId === input.questId && existing.actionHash === input.actionHash) {
        return this.read(existing)
      }
    }
    const now = this.clock.now()
    const seal: Seal = {
      ...input,
      id: crypto.randomUUID(),
      status: 'requested',
      requestedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SEAL_TTL_MS).toISOString(),
      decidedAt: null,
      decisionNote: null,
      reservedUntil: null,
      consumedAt: null,
    }
    this.seals(guildId).set(seal.id, seal)
    return { ...seal }
  }

  async get(guildId: string, id: string): Promise<Seal | null> {
    const seal = this.seals(guildId).get(id)
    return seal ? this.read(seal) : null
  }

  async list(
    guildId: string,
    page: { after?: string; limit: number; status?: SealStatus }
  ): Promise<SealPage> {
    const matching = [...this.seals(guildId).values()]
      .map((s) => this.read(s))
      .filter(
        (s) =>
          (page.after === undefined || s.id > page.after) && s.status === (page.status ?? s.status)
      )
      .sort((a, b) => (a.id < b.id ? -1 : 1))
    const seals = matching.slice(0, page.limit)
    const last = seals.at(-1)
    return { seals, next: matching.length > page.limit && last ? last.id : null }
  }

  async decide(
    guildId: string,
    id: string,
    decision: { verdict: 'approved' | 'denied'; expectedHash: string; note?: string }
  ): Promise<SealResult> {
    const stored = this.seals(guildId).get(id)
    if (!stored) {
      return { ok: false, reason: 'not_found' }
    }
    const seal = this.read(stored)
    if (seal.status === 'expired') {
      this.write(guildId, stored, { status: 'expired' })
      return { ok: false, reason: 'expired' }
    }
    if (seal.status !== 'requested') {
      return { ok: false, reason: 'not_requested' }
    }
    if (seal.actionHash !== decision.expectedHash) {
      return { ok: false, reason: 'hash_mismatch' }
    }
    return {
      ok: true,
      seal: this.write(guildId, stored, {
        status: decision.verdict,
        decidedAt: this.clock.now().toISOString(),
        decisionNote: decision.note ?? null,
      }),
    }
  }

  async reserve(guildId: string, id: string, hash: string): Promise<SealResult> {
    const stored = this.seals(guildId).get(id)
    if (!stored) {
      return { ok: false, reason: 'not_found' }
    }
    const seal = this.read(stored)
    if (seal.status !== 'approved' && seal.status !== 'released') {
      return { ok: false, reason: 'not_approved' }
    }
    if (seal.actionHash !== hash) {
      return { ok: false, reason: 'hash_mismatch' }
    }
    const until = new Date(this.clock.now().getTime() + SEAL_RESERVATION_MS)
    return {
      ok: true,
      seal: this.write(guildId, stored, { status: 'reserved', reservedUntil: until.toISOString() }),
    }
  }

  async consume(guildId: string, id: string, hash: string): Promise<SealResult> {
    return this.finishReservation(guildId, id, hash, 'consumed')
  }

  async release(guildId: string, id: string, hash: string): Promise<SealResult> {
    return this.finishReservation(guildId, id, hash, 'released')
  }

  private finishReservation(
    guildId: string,
    id: string,
    hash: string,
    to: 'consumed' | 'released'
  ): SealResult {
    const stored = this.seals(guildId).get(id)
    if (!stored) {
      return { ok: false, reason: 'not_found' }
    }
    const seal = this.read(stored)
    if (seal.status !== 'reserved') {
      return { ok: false, reason: 'not_reserved' }
    }
    if (seal.actionHash !== hash) {
      return { ok: false, reason: 'hash_mismatch' }
    }
    return {
      ok: true,
      seal: this.write(guildId, stored, {
        status: to,
        reservedUntil: null,
        consumedAt: to === 'consumed' ? this.clock.now().toISOString() : null,
      }),
    }
  }

  async markPosted(guildId: string, id: string, hash: string): Promise<SealResult> {
    const stored = this.seals(guildId).get(id)
    if (!stored) {
      return { ok: false, reason: 'not_found' }
    }
    const seal = this.read(stored)
    if (seal.status !== 'approved' && seal.status !== 'released') {
      return { ok: false, reason: 'not_approved' }
    }
    if (seal.actionHash !== hash) {
      return { ok: false, reason: 'hash_mismatch' }
    }
    return {
      ok: true,
      seal: this.write(guildId, stored, {
        status: 'consumed',
        reservedUntil: null,
        consumedAt: this.clock.now().toISOString(),
      }),
    }
  }

  async expireDue(guildId: string): Promise<number> {
    let count = 0
    for (const stored of this.seals(guildId).values()) {
      if (stored.status === 'requested' && this.read(stored).status === 'expired') {
        this.write(guildId, stored, { status: 'expired' })
        count++
      }
    }
    return count
  }
}
