import type { ConfigStore } from './ports/config-store'
import type { IdentityProvider } from './ports/identity'
import type {
  ReserveResult,
  Seal,
  SealPage,
  SealResult,
  SealStatus,
  SealStore,
} from './ports/seal-store'

/**
 * A name no agent may request under. Deciders are real member ids now (sessions resolve to a
 * principal), so this no longer identifies the decider; it only stops an agent posing as the
 * Guild Master by name.
 */
export const GUILD_MASTER_ID = 'guild-master'

/** Thrown by {@link SealEngine.requestSeal} when the requester id is reserved for the Guild Master. */
export class SealRequestError extends Error {
  constructor(readonly code: 'requester_reserved') {
    super(code)
    this.name = 'SealRequestError'
  }
}

/** Who is trying to decide a Seal: the session principal's role and member id. Only `guild_master` can, and never on its own request. */
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
  private readonly identity: Pick<IdentityProvider, 'findMember'>

  constructor(deps: {
    store: SealStore
    config: ConfigStore
    identity: Pick<IdentityProvider, 'findMember'>
  }) {
    this.identity = deps.identity
    this.store = deps.store
    this.config = deps.config
  }

  /**
   * Requests a Seal for an external action, bound to the hash of `input.text`. Idempotent per
   * quest and text. Reads the guild's Seal Policy first (throws `ConfigError` for an unseeded guild).
   */
  async requestSeal(guildId: string, input: SealRequest): Promise<Seal> {
    if (input.requestedBy.trim().toLowerCase() === GUILD_MASTER_ID) {
      throw new SealRequestError('requester_reserved')
    }
    await this.config.current(guildId)
    return this.store.request(guildId, input)
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
    return this.store.decide(guildId, id, { ...decision, decidedBy: decider.id })
  }

  /** Reserves an approved Seal for publishing `text`; returns the holder's one-time token. */
  reserve(guildId: string, id: string, text: string): Promise<ReserveResult> {
    return this.store.reserve(guildId, id, text)
  }

  /** Consumes the reservation held by `token` for exactly `text`; a Seal is single-use. */
  consume(guildId: string, id: string, use: { text: string; token: string }): Promise<SealResult> {
    return this.store.consume(guildId, id, use)
  }

  /** Gives the reservation held by `token` back unused. */
  release(guildId: string, id: string, use: { token: string }): Promise<SealResult> {
    return this.store.release(guildId, id, use)
  }

  /** Guild Master only (the caller must have spent a fresh re-auth): frees a stale reservation. */
  releaseStale(guildId: string, id: string): Promise<SealResult> {
    return this.store.releaseStale(guildId, id)
  }

  /** The Guild Master posted exactly `text` by hand: emits `post.published_manually`. */
  markPosted(
    guildId: string,
    id: string,
    text: string,
    auth: { reauthenticated: boolean }
  ): Promise<SealResult> {
    return this.store.markPosted(guildId, id, text, auth)
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
