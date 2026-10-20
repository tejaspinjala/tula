import { safeEqual } from '../constant-time'
import type { Clock } from '../ports/clock'
import {
  hashProposal,
  type NewSeal,
  type ReserveResult,
  SEAL_RESERVATION_MS,
  SEAL_TTL_MS,
  type Seal,
  type SealPage,
  type SealResult,
  type SealStatus,
  type SealStore,
} from '../ports/seal-store'

const EXPIRE_BATCH = 100

interface Stored {
  seal: Seal
  tokenHash: string | null
}

/** A fresh random reservation token (256 bits, hex). */
export function newReservationToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Memory adapter for {@link SealStore}: state in this instance only; every transition is synchronous. */
export class MemorySealStore implements SealStore {
  private readonly guilds = new Map<string, Map<string, Stored>>()

  constructor(private readonly clock: Clock) {}

  private seals(guildId: string): Map<string, Stored> {
    let seals = this.guilds.get(guildId)
    if (!seals) {
      seals = new Map()
      this.guilds.set(guildId, seals)
    }
    return seals
  }

  /** The Seal as read now: past-expiry requested reads expired; a lapsed reservation reads stale. */
  private read(seal: Seal): Seal {
    const now = this.clock.now().getTime()
    if (seal.status === 'requested' && Date.parse(seal.expiresAt) <= now) {
      return { ...seal, status: 'expired' }
    }
    if (seal.status === 'reserved' && seal.reservedUntil && Date.parse(seal.reservedUntil) <= now) {
      return { ...seal, stale: true }
    }
    return { ...seal }
  }

  private write(guildId: string, stored: Stored, patch: Partial<Seal>, tokenHash: string | null) {
    const next: Stored = { seal: { ...stored.seal, ...patch }, tokenHash }
    this.seals(guildId).set(stored.seal.id, next)
    return this.read(next.seal)
  }

  // Every method checks and writes with no await between them (hashing happens first), so
  // same-tick calls cannot interleave.
  async request(guildId: string, input: NewSeal): Promise<Seal> {
    const actionHash = await hashProposal(input.text)
    const round = input.round ?? 1
    for (const { seal } of this.seals(guildId).values()) {
      if (
        seal.questId === input.questId &&
        seal.round === round &&
        seal.actionHash === actionHash
      ) {
        return this.read(seal)
      }
    }
    const now = this.clock.now()
    const seal: Seal = {
      ...input,
      round,
      actionHash,
      id: crypto.randomUUID(),
      status: 'requested',
      stale: false,
      requestedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SEAL_TTL_MS).toISOString(),
      decidedAt: null,
      decisionNote: null,
      decidedBy: null,
      reservedUntil: null,
      consumedAt: null,
    }
    this.seals(guildId).set(seal.id, { seal, tokenHash: null })
    return { ...seal }
  }

  async forQuest(guildId: string, questId: string): Promise<Seal | null> {
    const latest = [...this.seals(guildId).values()]
      .map((s) => s.seal)
      .filter((s) => s.questId === questId)
      .sort((a, b) => b.round - a.round || (a.requestedAt < b.requestedAt ? 1 : -1))[0]
    return latest ? this.read(latest) : null
  }

  async get(guildId: string, id: string): Promise<Seal | null> {
    const stored = this.seals(guildId).get(id)
    return stored ? this.read(stored.seal) : null
  }

  async list(
    guildId: string,
    page: { after?: string; limit: number; status?: SealStatus }
  ): Promise<SealPage> {
    const matching = [...this.seals(guildId).values()]
      .map((s) => this.read(s.seal))
      .filter(
        (s) =>
          (page.after === undefined || s.id > page.after) &&
          (page.status === undefined || s.status === page.status)
      )
      .sort((a, b) => (a.id < b.id ? -1 : 1))
    const seals = matching.slice(0, page.limit)
    const last = seals.at(-1)
    return { seals, next: matching.length > page.limit && last ? last.id : null }
  }

  async decide(
    guildId: string,
    id: string,
    decision: {
      verdict: 'approved' | 'denied'
      expectedHash: string
      note?: string
      decidedBy?: string
    }
  ): Promise<SealResult> {
    const stored = this.seals(guildId).get(id)
    if (!stored) {
      return { ok: false, reason: 'not_found' }
    }
    const seal = this.read(stored.seal)
    if (seal.status === 'expired') {
      this.write(guildId, stored, { status: 'expired' }, null)
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
      seal: this.write(
        guildId,
        stored,
        {
          status: decision.verdict,
          decidedAt: this.clock.now().toISOString(),
          decisionNote: decision.note ?? null,
          decidedBy: decision.decidedBy ?? null,
        },
        null
      ),
    }
  }

  async reserve(guildId: string, id: string, text: string): Promise<ReserveResult> {
    const hash = await hashProposal(text)
    const token = newReservationToken()
    const tokenHash = await hashProposal(token)
    const stored = this.seals(guildId).get(id)
    if (!stored) {
      return { ok: false, reason: 'not_found' }
    }
    const seal = this.read(stored.seal)
    if (seal.status !== 'approved' && seal.status !== 'released') {
      return { ok: false, reason: 'not_approved' }
    }
    if (seal.actionHash !== hash) {
      return { ok: false, reason: 'hash_mismatch' }
    }
    const until = new Date(this.clock.now().getTime() + SEAL_RESERVATION_MS).toISOString()
    return {
      ok: true,
      token,
      seal: this.write(guildId, stored, { status: 'reserved', reservedUntil: until }, tokenHash),
    }
  }

  async consume(
    guildId: string,
    id: string,
    use: { text: string; token: string }
  ): Promise<SealResult> {
    const hash = await hashProposal(use.text)
    const tokenHash = await hashProposal(use.token)
    const stored = this.seals(guildId).get(id)
    if (!stored) {
      return { ok: false, reason: 'not_found' }
    }
    if (stored.seal.status !== 'reserved') {
      return { ok: false, reason: 'not_reserved' }
    }
    if (stored.tokenHash === null || !safeEqual(stored.tokenHash, tokenHash)) {
      return { ok: false, reason: 'bad_token' }
    }
    if (stored.seal.actionHash !== hash) {
      return { ok: false, reason: 'hash_mismatch' }
    }
    return {
      ok: true,
      seal: this.write(
        guildId,
        stored,
        { status: 'consumed', reservedUntil: null, consumedAt: this.clock.now().toISOString() },
        null
      ),
    }
  }

  async release(guildId: string, id: string, use: { token: string }): Promise<SealResult> {
    const tokenHash = await hashProposal(use.token)
    const stored = this.seals(guildId).get(id)
    if (!stored) {
      return { ok: false, reason: 'not_found' }
    }
    if (stored.seal.status !== 'reserved') {
      return { ok: false, reason: 'not_reserved' }
    }
    if (stored.tokenHash === null || !safeEqual(stored.tokenHash, tokenHash)) {
      return { ok: false, reason: 'bad_token' }
    }
    return {
      ok: true,
      seal: this.write(guildId, stored, { status: 'released', reservedUntil: null }, null),
    }
  }

  async releaseStale(guildId: string, id: string): Promise<SealResult> {
    const stored = this.seals(guildId).get(id)
    if (!stored) {
      return { ok: false, reason: 'not_found' }
    }
    if (!this.read(stored.seal).stale) {
      return { ok: false, reason: 'not_stale' }
    }
    return {
      ok: true,
      seal: this.write(guildId, stored, { status: 'released', reservedUntil: null }, null),
    }
  }

  async markPosted(
    guildId: string,
    id: string,
    text: string,
    auth: { reauthenticated: boolean }
  ): Promise<SealResult> {
    const hash = await hashProposal(text)
    const stored = this.seals(guildId).get(id)
    if (!stored) {
      return { ok: false, reason: 'not_found' }
    }
    const seal = this.read(stored.seal)
    const usable = seal.status === 'approved' || seal.status === 'released' || seal.stale
    if (!usable) {
      return { ok: false, reason: 'not_approved' }
    }
    if (seal.stale && !auth.reauthenticated) {
      return { ok: false, reason: 'not_authorised' }
    }
    if (seal.actionHash !== hash) {
      return { ok: false, reason: 'hash_mismatch' }
    }
    return {
      ok: true,
      seal: this.write(
        guildId,
        stored,
        { status: 'consumed', reservedUntil: null, consumedAt: this.clock.now().toISOString() },
        null
      ),
    }
  }

  async expireDue(guildId: string, opts?: { approvedWindowMs?: number }): Promise<number> {
    const now = this.clock.now().getTime()
    const window = opts?.approvedWindowMs
    let count = 0
    for (const stored of this.seals(guildId).values()) {
      if (count >= EXPIRE_BATCH) {
        break
      }
      const { seal } = stored
      const lapsedRequest = seal.status === 'requested' && this.read(seal).status === 'expired'
      const lapsedApproval =
        window !== undefined &&
        seal.status === 'approved' &&
        seal.decidedAt !== null &&
        Date.parse(seal.decidedAt) + window <= now
      if (lapsedRequest || lapsedApproval) {
        this.write(guildId, stored, { status: 'expired' }, null)
        count++
      }
    }
    return count
  }
}
