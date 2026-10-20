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
  /** Records an event carrying ids and amounts only. */
  emit(type: string, payload: Record<string, string | number>): Promise<void>
}

const isCents = (n: number): boolean => Number.isSafeInteger(n) && n > 0

/** The hash an entry must carry: SHA-256 over the previous hash and every field of the entry. */
export function entryHash(e: Omit<LedgerEntry, 'hash'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        e.prevHash,
        e.seq,
        e.id,
        e.kind,
        e.bucket,
        e.amountCents,
        e.mode,
        e.spendId,
        e.idemKey,
        e.evidence,
        e.day,
        e.createdAt,
      ])
    )
    .digest('hex')
}

/** What to append: the caller supplies meaning, the core supplies seq, id, time and hashes. */
interface Draft {
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

  protected today(): string {
    return this.clock.now().toISOString().slice(0, 10)
  }

  /** Appends one chained entry inside `tx`. */
  protected async post(tx: TreasuryTx, draft: Draft): Promise<LedgerEntry> {
    const last = await tx.lastEntry()
    const now = this.clock.now().toISOString()
    const body = {
      seq: (last?.seq ?? 0) + 1,
      id: crypto.randomUUID(),
      kind: draft.kind,
      bucket: draft.bucket,
      amountCents: draft.amountCents,
      mode: 'paper' as const,
      spendId: draft.spendId ?? null,
      idemKey: draft.idemKey ?? null,
      evidence: draft.evidence ?? null,
      day: now.slice(0, 10),
      createdAt: now,
      prevHash: last?.hash ?? LEDGER_GENESIS,
    }
    const entry: LedgerEntry = { ...body, hash: entryHash(body) }
    await tx.append(entry)
    await tx.emit('treasury.entry', {
      entryId: entry.id,
      seq: entry.seq,
      kind: entry.kind,
      bucket: entry.bucket,
      amountCents: entry.amountCents,
      hash: entry.hash,
    })
    return entry
  }

  /** Funds a new guild's Treasury: $100 of paper, `reservePercent` of it in reserve. */
  protected async ensureFunded(tx: TreasuryTx, limits: TreasuryLimits): Promise<void> {
    if (await tx.lastEntry()) {
      return
    }
    const reserve = Math.floor((STARTING_FUNDS_CENTS * limits.reservePercent) / 100)
    const draft = { kind: 'seed' as const, idemKey: 'seed' }
    if (reserve > 0) {
      await this.post(tx, { ...draft, bucket: 'reserve', amountCents: reserve })
    }
    await this.post(tx, {
      ...draft,
      bucket: 'operating',
      amountCents: STARTING_FUNDS_CENTS - reserve,
    })
  }

  async snapshot(guildId: string, limits: TreasuryLimits): Promise<TreasurySnapshot> {
    return this.run(guildId, 'write', async (tx) => {
      await this.ensureFunded(tx, limits)
      const day = this.today()
      return {
        mode: 'paper',
        balances: await tx.balances(),
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
    return this.run(guildId, 'write', async (tx): Promise<EntriesResult> => {
      await this.ensureFunded(tx, limits)
      const idemKey = `revenue:${input.key}`
      const seen = await tx.entriesByKey(idemKey)
      if (seen.length > 0) {
        return { ok: true, entries: seen, created: false }
      }
      const reinvest = Math.floor((input.amountCents * limits.reinvestPercent) / 100)
      const entries: LedgerEntry[] = []
      for (const [bucket, amountCents] of [
        ['operating', reinvest],
        ['profit', input.amountCents - reinvest],
      ] as const) {
        if (amountCents > 0) {
          entries.push(
            await this.post(tx, { kind: 'revenue', bucket, amountCents, idemKey, evidence })
          )
        }
      }
      return { ok: true, entries, created: true }
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
                : hash !== entryHash(body)
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
