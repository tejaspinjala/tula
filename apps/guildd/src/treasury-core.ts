import { createHash } from 'node:crypto'
import type { TreasuryLimits } from './guild-config'
import type { Clock } from './ports/clock'
import {
  type Balances,
  type Bucket,
  type EntriesResult,
  type EntryKind,
  type LedgerEntry,
  type LedgerVerdict,
  MAX_TREASURY_PAGE,
  type NewRevenue,
  type NewSpend,
  type Spend,
  type SpendResult,
  STARTING_FUNDS_CENTS,
  type TreasuryPage,
  type TreasurySnapshot,
} from './ports/treasury-store'

/** The `prevHash` of a guild's first ledger entry. */
export const LEDGER_GENESIS = '0'.repeat(64)
/** Entries one verify page reads. */
const VERIFY_PAGE = 500

/**
 * What the core needs from storage, inside one atomic unit. A write unit is serialised per
 * guild by the adapter (an advisory lock, or a per-guild queue in memory), so a check made here
 * and the append it guards cannot interleave with another request.
 */
export interface TreasuryTx {
  /** The newest ledger entry, or null for an unfunded Treasury. */
  lastEntry(): Promise<LedgerEntry | null>
  /** Sum of entries per bucket. */
  balances(): Promise<Balances>
  /** Net cents spent (reserved, minus released or refunded) by entries dated `day`. */
  spentOn(day: string): Promise<number>
  /** Entries recorded under an idempotency key, oldest first. */
  entriesByKey(idemKey: string): Promise<LedgerEntry[]>
  /** Appends an entry; the adapter enforces append-only. */
  append(entry: LedgerEntry): Promise<void>
  /** Entries after `afterSeq`, oldest first. */
  entriesAfter(afterSeq: number, limit: number): Promise<LedgerEntry[]>
  /** The spend request filed under an idempotency key, or null. */
  spendByKey(key: string): Promise<Spend | null>
  /** One spend request by id, or null. */
  spendById(id: string): Promise<Spend | null>
  /** Spend requests after `afterSeq`, oldest first. */
  spendsAfter(afterSeq: number, limit: number): Promise<Spend[]>
  /** Replaces a spend request's mutable state (status, settled cents, approver, escalation). */
  updateSpend(spend: Spend): Promise<void>
  /** Inserts a spend request, assigning its per-guild `seq`. */
  insertSpend(spend: Omit<Spend, 'seq'>): Promise<Spend>
  /** Records an event carrying ids and amounts only. */
  emit(type: string, payload: Record<string, string | number>): Promise<void>
}

const isCents = (n: number): boolean => Number.isSafeInteger(n) && n > 0

/**
 * The hash an entry must carry: SHA-256 over the guild, the previous hash and every field of the
 * entry (so an entry cannot be replayed into another guild's chain). The chain detects altered,
 * removed or reordered entries; truncating the tail needs an external anchor, as audit checkpoints do (#31).
 */
export function entryHash(guildId: string, e: Omit<LedgerEntry, 'hash'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        guildId,
        e.prevHash,
        e.seq,
        e.id,
        e.kind,
        e.bucket,
        e.amountCents,
        e.mode,
        e.spendId,
        e.idemKey,
        e.actorMember,
        e.evidence,
        e.day,
        e.createdAt,
      ])
    )
    .digest('hex')
}

/** What to append: the caller supplies meaning, the core supplies seq, id, time and hashes. */
interface Draft {
  actorMember?: string
  kind: EntryKind
  bucket: Bucket
  amountCents: number
  spendId?: string
  idemKey?: string
  evidence?: string
}

/**
 * The Treasury rules, written once over an abstract {@link TreasuryTx}. Memory and Postgres
 * adapters supply the runner; neither re-implements a rule. Never a model decision: every
 * outcome is arithmetic on integer cents.
 */
export abstract class TreasuryCore {
  protected constructor(protected readonly clock: Clock) {}

  /** Runs `fn` as one atomic unit for a guild; `write` units are serialised per guild. */
  protected abstract run<T>(
    guildId: string,
    mode: 'read' | 'write',
    fn: (tx: TreasuryTx) => Promise<T>
  ): Promise<T>

  /**
   * Runs a write unit with the instant read ONCE: the cap check, the spend row and every entry of
   * the operation share it, so a tick across UTC midnight cannot split the day checked from the
   * day posted.
   */
  private unit<T>(guildId: string, fn: (tx: TreasuryTx, at: Date) => Promise<T>): Promise<T> {
    return this.run(guildId, 'write', (tx) => fn(tx, this.clock.now()))
  }

  /** Appends one chained entry inside `tx`. */
  protected async post(
    guildId: string,
    tx: TreasuryTx,
    at: Date,
    draft: Draft
  ): Promise<LedgerEntry> {
    const last = await tx.lastEntry()
    const now = at.toISOString()
    const body = {
      seq: (last?.seq ?? 0) + 1,
      id: crypto.randomUUID(),
      kind: draft.kind,
      bucket: draft.bucket,
      amountCents: draft.amountCents,
      mode: 'paper' as const,
      spendId: draft.spendId ?? null,
      idemKey: draft.idemKey ?? null,
      actorMember: draft.actorMember ?? null,
      evidence: draft.evidence ?? null,
      day: now.slice(0, 10),
      createdAt: now,
      prevHash: last?.hash ?? LEDGER_GENESIS,
    }
    const entry: LedgerEntry = { ...body, hash: entryHash(guildId, body) }
    await tx.append(entry)
    await tx.emit('treasury.entry', {
      entryId: entry.id,
      seq: entry.seq,
      kind: entry.kind,
      bucket: entry.bucket,
      amountCents: entry.amountCents,
      hash: entry.hash,
      ...(entry.actorMember ? { memberId: entry.actorMember } : {}),
    })
    return entry
  }

  /** Funds a new guild's Treasury: $100 of paper, `reservePercent` of it in reserve. */
  protected async ensureFunded(
    guildId: string,
    tx: TreasuryTx,
    at: Date,
    limits: TreasuryLimits
  ): Promise<void> {
    if (await tx.lastEntry()) {
      return
    }
    const reserve = Math.floor((STARTING_FUNDS_CENTS * limits.reservePercent) / 100)
    const draft = { kind: 'seed' as const, idemKey: 'seed' }
    if (reserve > 0) {
      await this.post(guildId, tx, at, { ...draft, bucket: 'reserve', amountCents: reserve })
    }
    await this.post(guildId, tx, at, {
      ...draft,
      bucket: 'operating',
      amountCents: STARTING_FUNDS_CENTS - reserve,
    })
  }

  /**
   * Read-only: a Treasury that has never been written shows the funding it will get (the $100 split)
   * without posting it; the first write funds it. Opening the Treasury never appends an event.
   */
  async snapshot(guildId: string, limits: TreasuryLimits): Promise<TreasurySnapshot> {
    const day = this.clock.now().toISOString().slice(0, 10)
    return this.run(guildId, 'read', async (tx) => {
      const funded = (await tx.lastEntry()) !== null
      const reserve = Math.floor((STARTING_FUNDS_CENTS * limits.reservePercent) / 100)
      return {
        mode: 'paper',
        balances: funded
          ? await tx.balances()
          : { operating: STARTING_FUNDS_CENTS - reserve, reserve, profit: 0 },
        spentTodayCents: await tx.spentOn(day),
        day,
      }
    })
  }

  async recordRevenue(
    guildId: string,
    input: NewRevenue,
    limits: TreasuryLimits
  ): Promise<EntriesResult> {
    const evidence = input.evidence.trim()
    if (!isCents(input.amountCents)) {
      return { ok: false, reason: 'invalid_amount' }
    }
    if (evidence === '') {
      return { ok: false, reason: 'evidence_required' }
    }
    return this.unit(guildId, async (tx, at): Promise<EntriesResult> => {
      await this.ensureFunded(guildId, tx, at, limits)
      const idemKey = `revenue:${input.key}`
      const seen = await tx.entriesByKey(idemKey)
      if (seen.length > 0) {
        // The same key with other terms is a different request wearing a used key: refuse it.
        const total = seen.reduce((sum, e) => sum + e.amountCents, 0)
        return total === input.amountCents && seen.every((e) => e.evidence === evidence)
          ? { ok: true, entries: seen, created: false }
          : { ok: false, reason: 'idempotency_conflict' }
      }
      const reinvest = Math.floor((input.amountCents * limits.reinvestPercent) / 100)
      const entries: LedgerEntry[] = []
      for (const [bucket, amountCents] of [
        ['operating', reinvest],
        ['profit', input.amountCents - reinvest],
      ] as const) {
        if (amountCents > 0) {
          entries.push(
            await this.post(guildId, tx, at, {
              kind: 'revenue',
              bucket,
              amountCents,
              idemKey,
              evidence,
              actorMember: input.actorMember,
            })
          )
        }
      }
      return { ok: true, entries, created: true }
    })
  }

  async requestSpend(
    guildId: string,
    input: NewSpend,
    limits: TreasuryLimits
  ): Promise<SpendResult> {
    if (!isCents(input.amountCents)) {
      return { ok: false, reason: 'invalid_amount' }
    }
    return this.unit(guildId, async (tx, at): Promise<SpendResult> => {
      await this.ensureFunded(guildId, tx, at, limits)
      const seen = await tx.spendByKey(input.key)
      if (seen) {
        return seen.amountCents === input.amountCents && seen.purpose === input.purpose
          ? { ok: true, spend: seen, created: false }
          : { ok: false, reason: 'idempotency_conflict' }
      }
      const { operating } = await tx.balances()
      if (input.amountCents > operating) {
        return { ok: false, reason: 'insufficient_funds' }
      }
      const spentToday = await tx.spentOn(at.toISOString().slice(0, 10))
      const escalation =
        input.amountCents > limits.treasurerLimitCents
          ? ('over_treasurer_limit' as const)
          : spentToday + input.amountCents > limits.dailyCapCents
            ? ('daily_cap' as const)
            : null
      const spend = await tx.insertSpend({
        id: crypto.randomUUID(),
        key: input.key,
        amountCents: input.amountCents,
        settledCents: null,
        purpose: input.purpose,
        requestedBy: input.requestedBy,
        status: escalation ? 'pending_approval' : 'reserved',
        escalation,
        approvedBy: escalation ? null : 'treasurer',
        approvedByMember: null,
        createdAt: at.toISOString(),
      })
      if (!escalation) {
        await this.post(guildId, tx, at, {
          actorMember: input.requestedBy,
          kind: 'spend_reserve',
          bucket: 'operating',
          amountCents: -spend.amountCents,
          spendId: spend.id,
        })
      }
      await tx.emit('treasury.spend', {
        spendId: spend.id,
        status: spend.status,
        amountCents: spend.amountCents,
        memberId: input.requestedBy,
      })
      return { ok: true, spend, created: true }
    })
  }

  /** Moves a spend request to a new state in the same unit as the entry that backs it. */
  private async moveSpend(
    tx: TreasuryTx,
    spend: Spend,
    change: Partial<
      Pick<Spend, 'status' | 'settledCents' | 'approvedBy' | 'approvedByMember' | 'escalation'>
    >,
    actorMember: string
  ): Promise<Spend> {
    const next: Spend = { ...spend, ...change }
    await tx.updateSpend(next)
    await tx.emit('treasury.spend', {
      spendId: next.id,
      status: next.status,
      amountCents: next.settledCents ?? next.amountCents,
      memberId: actorMember,
    })
    return next
  }

  /** Runs `fn` on the spend `spendId` as one write unit, or refuses when there is none. */
  private async withSpend(
    guildId: string,
    spendId: string,
    fn: (tx: TreasuryTx, spend: Spend, at: Date) => Promise<SpendResult>
  ): Promise<SpendResult> {
    return this.unit(guildId, async (tx, at) => {
      const spend = await tx.spendById(spendId)
      return spend ? fn(tx, spend, at) : { ok: false, reason: 'not_found' }
    })
  }

  approveSpend(guildId: string, spendId: string, actorMember: string): Promise<SpendResult> {
    return this.withSpend(guildId, spendId, async (tx, spend, at): Promise<SpendResult> => {
      if (spend.status !== 'pending_approval') {
        return { ok: false, reason: 'wrong_state' }
      }
      // Funds are checked again now: the envelope may have been spent while the request waited.
      if (spend.amountCents > (await tx.balances()).operating) {
        return { ok: false, reason: 'insufficient_funds' }
      }
      await this.post(guildId, tx, at, {
        actorMember,
        kind: 'spend_reserve',
        bucket: 'operating',
        amountCents: -spend.amountCents,
        spendId: spend.id,
      })
      const next = await this.moveSpend(
        tx,
        spend,
        {
          status: 'reserved',
          approvedBy: 'guild_master',
          approvedByMember: actorMember,
          escalation: null,
        },
        actorMember
      )
      return { ok: true, spend: next, created: false }
    })
  }

  denySpend(guildId: string, spendId: string, actorMember: string): Promise<SpendResult> {
    return this.withSpend(guildId, spendId, async (tx, spend): Promise<SpendResult> => {
      if (spend.status !== 'pending_approval') {
        return { ok: false, reason: 'wrong_state' }
      }
      return {
        ok: true,
        spend: await this.moveSpend(tx, spend, { status: 'denied' }, actorMember),
        created: false,
      }
    })
  }

  settleSpend(
    guildId: string,
    spendId: string,
    actualCents: number,
    actorMember: string
  ): Promise<SpendResult> {
    if (!Number.isSafeInteger(actualCents) || actualCents < 0) {
      return Promise.resolve({ ok: false, reason: 'invalid_amount' })
    }
    return this.withSpend(guildId, spendId, async (tx, spend, at): Promise<SpendResult> => {
      if (spend.status === 'settled' && spend.settledCents === actualCents) {
        return { ok: true, spend, created: false }
      }
      if (spend.status !== 'reserved') {
        return { ok: false, reason: 'wrong_state' }
      }
      if (actualCents > spend.amountCents) {
        return { ok: false, reason: 'exceeds_reserved' }
      }
      const refund = spend.amountCents - actualCents
      if (refund > 0) {
        await this.post(guildId, tx, at, {
          actorMember,
          kind: 'spend_settle',
          bucket: 'operating',
          amountCents: refund,
          spendId: spend.id,
        })
      }
      const next = await this.moveSpend(
        tx,
        spend,
        { status: 'settled', settledCents: actualCents },
        actorMember
      )
      return { ok: true, spend: next, created: false }
    })
  }

  releaseSpend(guildId: string, spendId: string, actorMember: string): Promise<SpendResult> {
    return this.withSpend(guildId, spendId, async (tx, spend, at): Promise<SpendResult> => {
      if (spend.status === 'released') {
        return { ok: true, spend, created: false }
      }
      if (spend.status !== 'reserved') {
        return { ok: false, reason: 'wrong_state' }
      }
      await this.post(guildId, tx, at, {
        actorMember,
        kind: 'spend_release',
        bucket: 'operating',
        amountCents: spend.amountCents,
        spendId: spend.id,
      })
      return {
        ok: true,
        spend: await this.moveSpend(tx, spend, { status: 'released' }, actorMember),
        created: false,
      }
    })
  }

  async getSpend(guildId: string, spendId: string): Promise<Spend | null> {
    return this.run(guildId, 'read', (tx) => tx.spendById(spendId))
  }

  async listSpends(
    guildId: string,
    page: { after?: number; limit: number }
  ): Promise<TreasuryPage<Spend>> {
    const limit = Math.min(Math.max(page.limit, 1), MAX_TREASURY_PAGE)
    const rows = await this.run(guildId, 'read', (tx) => tx.spendsAfter(page.after ?? 0, limit + 1))
    const items = rows.slice(0, limit)
    const last = items.at(-1)
    return { items, next: rows.length > limit && last ? last.seq : null }
  }

  async releaseReserve(
    guildId: string,
    input: { key: string; amountCents: number; actorMember: string },
    limits: TreasuryLimits
  ): Promise<EntriesResult> {
    if (!isCents(input.amountCents)) {
      return { ok: false, reason: 'invalid_amount' }
    }
    return this.unit(guildId, async (tx, at): Promise<EntriesResult> => {
      await this.ensureFunded(guildId, tx, at, limits)
      const idemKey = `reserve:${input.key}`
      const seen = await tx.entriesByKey(idemKey)
      if (seen.length > 0) {
        const released = seen.find((e) => e.bucket === 'reserve')
        return released?.amountCents === -input.amountCents
          ? { ok: true, entries: seen, created: false }
          : { ok: false, reason: 'idempotency_conflict' }
      }
      if (input.amountCents > (await tx.balances()).reserve) {
        return { ok: false, reason: 'insufficient_funds' }
      }
      const out = await this.post(guildId, tx, at, {
        actorMember: input.actorMember,
        kind: 'reserve_release',
        bucket: 'reserve',
        amountCents: -input.amountCents,
        idemKey,
      })
      const into = await this.post(guildId, tx, at, {
        actorMember: input.actorMember,
        kind: 'reserve_release',
        bucket: 'operating',
        amountCents: input.amountCents,
        idemKey,
      })
      return { ok: true, entries: [out, into], created: true }
    })
  }

  async listEntries(
    guildId: string,
    page: { after?: number; limit: number }
  ): Promise<TreasuryPage<LedgerEntry>> {
    const limit = Math.min(Math.max(page.limit, 1), MAX_TREASURY_PAGE)
    const rows = await this.run(guildId, 'read', (tx) =>
      tx.entriesAfter(page.after ?? 0, limit + 1)
    )
    const items = rows.slice(0, limit)
    const last = items.at(-1)
    return { items, next: rows.length > limit && last ? last.seq : null }
  }

  async verifyLedger(guildId: string): Promise<LedgerVerdict> {
    return this.run(guildId, 'read', async (tx): Promise<LedgerVerdict> => {
      let prev: LedgerEntry | null = null
      let count = 0
      for (;;) {
        const page = await tx.entriesAfter(prev?.seq ?? 0, VERIFY_PAGE)
        for (const e of page) {
          const { hash, ...body } = e
          const bad =
            e.seq !== (prev?.seq ?? 0) + 1
              ? 'sequence gap or reorder'
              : e.prevHash !== (prev?.hash ?? LEDGER_GENESIS)
                ? 'chain link broken'
                : hash !== entryHash(guildId, body)
                  ? 'entry altered'
                  : null
          if (bad) {
            return { intact: false, firstBadSeq: e.seq, reason: bad }
          }
          prev = e
          count += 1
        }
        if (page.length < VERIFY_PAGE) {
          return { intact: true, entries: count }
        }
      }
    })
  }
}
