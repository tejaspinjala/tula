import type { ConfigStore } from './ports/config-store'
import {
  hashProposal,
  type Seal,
  type SealPage,
  type SealResult,
  type SealStatus,
  type SealStore,
} from './ports/seal-store'

/** Who is trying to decide a Seal. Only `guild_master` can; the id is checked against the requester. */
export interface SealDecider {
  role: 'guild_master' | 'agent'
  id: string
}

/** What a Quest hands the engine when its Proposal needs a Seal. */
export interface SealRequest {
  questId: string
  requestedBy: string
  kind: string
  /** The exact Proposal text; the Seal is bound to its hash. */
  text: string
  evidence: string
}

/**
 * The Seal engine: the API Quests call. All of it is deterministic code (no model decides): Seal
 * Policy comes from the guild config, authority is checked here, and the store makes every
 * transition atomic. In this slice `always` is the only reachable Seal Policy level, so every
 * external action needs a Seal; any other level is treated as `always` until it is built.
 */
export class SealEngine {
  private readonly store: SealStore
  private readonly config: ConfigStore

  constructor(deps: { store: SealStore; config: ConfigStore }) {
    this.store = deps.store
    this.config = deps.config
  }

  /**
   * Requests a Seal for an external action, bound to the hash of `input.text`. Idempotent per
   * quest and text. Reads the guild's Seal Policy first (throws `ConfigError` for an unseeded guild).
   */
  async requestSeal(guildId: string, input: SealRequest): Promise<Seal> {
    await this.config.current(guildId)
    return this.store.request(guildId, {
      ...input,
      actionHash: await hashProposal(input.text),
    })
  }

  /**
   * Approves or denies a Seal against the hash the decider saw. Ignored (`not_authorised`, no
   * change) unless the decider is the Guild Master and is not the Seal's requester.
   */
  async decide(
    guildId: string,
    id: string,
    decision: { verdict: 'approved' | 'denied'; expectedHash: string; note?: string },
    decider: SealDecider
  ): Promise<SealResult> {
    const seal = await this.store.get(guildId, id)
    if (!seal) {
      return { ok: false, reason: 'not_found' }
    }
    if (decider.role !== 'guild_master' || decider.id === seal.requestedBy) {
      return { ok: false, reason: 'not_authorised' }
    }
    return this.store.decide(guildId, id, decision)
  }

  /** Reserves an approved Seal for an action with this hash. */
  reserve(guildId: string, id: string, hash: string): Promise<SealResult> {
    return this.store.reserve(guildId, id, hash)
  }

  /** Consumes the reservation; a Seal is single-use. */
  consume(guildId: string, id: string, hash: string): Promise<SealResult> {
    return this.store.consume(guildId, id, hash)
  }

  /** Gives a reservation back unused. */
  release(guildId: string, id: string, hash: string): Promise<SealResult> {
    return this.store.release(guildId, id, hash)
  }

  /** The Guild Master posted the approved text by hand: emits `post.published_manually`. */
  markPosted(guildId: string, id: string, hash: string): Promise<SealResult> {
    return this.store.markPosted(guildId, id, hash)
  }

  /** One Seal, or null. */
  get(guildId: string, id: string): Promise<Seal | null> {
    return this.store.get(guildId, id)
  }

  /** A page of Seals, after persisting any expiry that has come due. */
  async list(
    guildId: string,
    page: { after?: string; limit: number; status?: SealStatus }
  ): Promise<SealPage> {
    await this.store.expireDue(guildId)
    return this.store.list(guildId, page)
  }
}
