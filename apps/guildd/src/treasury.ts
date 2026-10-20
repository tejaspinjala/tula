import { guildTreasury, type TreasuryLimits } from './guild-config'
import type { ConfigStore } from './ports/config-store'
import type {
  EntriesResult,
  LedgerEntry,
  LedgerVerdict,
  NewRevenue,
  Spend,
  SpendResult,
  TreasuryPage,
  TreasuryStore,
} from './ports/treasury-store'

/** Whether a session principal may act on the Treasury: only the Guild Master, the one human role. */
export function isGuildMaster(principal: { role: string }): boolean {
  return principal.role === 'guild_master'
}

/** The Treasury at a glance, with the envelope limits in force. */
export interface TreasuryOverview {
  mode: 'paper'
  balances: { operating: number; reserve: number; profit: number }
  spentTodayCents: number
  day: string
  limits: TreasuryLimits
}

/**
 * The paper Treasury: deterministic spend rules over a {@link TreasuryStore}, with the envelope
 * limits read from guild config at the moment of each call. Nothing here is a model decision and
 * nothing here calls a payment provider: it moves paper cents between ledger buckets, nothing
 * else. Routes gate who may call what (writes need a session; approvals and reserve releases need
 * re-authentication); no agent-facing tool is wired to this class.
 */
export class Treasury {
  private readonly store: TreasuryStore
  private readonly config: ConfigStore

  constructor(deps: { store: TreasuryStore; config: ConfigStore }) {
    this.store = deps.store
    this.config = deps.config
  }

  private async limits(guildId: string): Promise<TreasuryLimits> {
    return guildTreasury((await this.config.current(guildId)).config)
  }

  /** Balances, today's net spend and the limits in force. Read-only: never funds the Treasury. */
  async overview(guildId: string): Promise<TreasuryOverview> {
    const limits = await this.limits(guildId)
    return { ...(await this.store.snapshot(guildId, limits)), limits }
  }

  /** Records revenue; rejected without evidence. */
  async recordRevenue(guildId: string, input: NewRevenue): Promise<EntriesResult> {
    return this.store.recordRevenue(guildId, input, await this.limits(guildId))
  }

  /** Guild Master only (the route demands re-authentication): reserve to operating. */
  async releaseReserve(
    guildId: string,
    input: { key: string; amountCents: number; actorMember: string }
  ): Promise<EntriesResult> {
    return this.store.releaseReserve(guildId, input, await this.limits(guildId))
  }

  /** Checks a spend against the envelope; the Treasurer reserves it or it waits for the Guild Master. */
  async requestSpend(
    guildId: string,
    input: { key: string; amountCents: number; purpose: string; requestedBy: string }
  ): Promise<SpendResult> {
    return this.store.requestSpend(guildId, input, await this.limits(guildId))
  }

  /** Guild Master only (the route demands re-authentication). */
  approveSpend(guildId: string, spendId: string, actorMember: string): Promise<SpendResult> {
    return this.store.approveSpend(guildId, spendId, actorMember)
  }

  /** Denies a waiting spend. */
  denySpend(guildId: string, spendId: string, actorMember: string): Promise<SpendResult> {
    return this.store.denySpend(guildId, spendId, actorMember)
  }

  /** Settles a reservation at the amount actually spent. */
  settleSpend(
    guildId: string,
    spendId: string,
    actualCents: number,
    actorMember: string
  ): Promise<SpendResult> {
    return this.store.settleSpend(guildId, spendId, actualCents, actorMember)
  }

  /** Releases a reservation: nothing was spent. */
  releaseSpend(guildId: string, spendId: string, actorMember: string): Promise<SpendResult> {
    return this.store.releaseSpend(guildId, spendId, actorMember)
  }

  /** Gives back the spend recorded under `key` (see {@link TreasuryStore.releaseSpendByKey}). */
  releaseSpendByKey(guildId: string, key: string, actorMember: string): Promise<SpendResult> {
    return this.store.releaseSpendByKey(guildId, key, actorMember)
  }

  /** Spend requests, oldest first. */
  async spends(
    guildId: string,
    page: { after?: number; limit: number }
  ): Promise<TreasuryPage<Spend>> {
    return this.store.listSpends(guildId, page)
  }

  /** Ledger entries, oldest first. */
  async entries(
    guildId: string,
    page: { after?: number; limit: number }
  ): Promise<TreasuryPage<LedgerEntry>> {
    return this.store.listEntries(guildId, page)
  }

  /** Replays the ledger's hash chain. */
  async verify(guildId: string): Promise<LedgerVerdict> {
    return this.store.verifyLedger(guildId)
  }
}
