import { guildContentPolicy } from './guild-config'
import type { ConfigStore } from './ports/config-store'
import type {
  NewProposal,
  Proposal,
  ProposalPage,
  ProposalStore,
  Verdict,
} from './ports/proposal-store'
import { allPassed, type ContentPolicy, DEFAULT_POLICY, runChecks } from './verdict'

/**
 * The Proposal engine: turns drafted content into a Proposal bound to its hash and runs the
 * deterministic checks (no model) to produce the Verdict bound to the same hash. An edit is a new
 * Proposal, so a Verdict can never be carried over to different content.
 */
export class ProposalEngine {
  private readonly store: ProposalStore
  private readonly policy: ContentPolicy
  private readonly config: Pick<ConfigStore, 'current'> | undefined

  /** With `config`, each guild's own content policy applies; without it, `policy` (else the default). */
  constructor(deps: {
    store: ProposalStore
    config?: Pick<ConfigStore, 'current'>
    policy?: ContentPolicy
  }) {
    this.store = deps.store
    this.config = deps.config
    this.policy = deps.policy ?? DEFAULT_POLICY
  }

  /** Stores the Proposal with its Verdict. Idempotent per content hash. */
  async propose(guildId: string, input: NewProposal): Promise<Proposal> {
    const policy = this.config
      ? guildContentPolicy((await this.config.current(guildId)).config)
      : this.policy
    const findings = runChecks(input.content, policy)
    return this.store.propose(guildId, input, { passed: allPassed(findings), findings })
  }

  /** One Proposal, or null. */
  get(guildId: string, id: string): Promise<Proposal | null> {
    return this.store.get(guildId, id)
  }

  /** Up to `limit` Proposals of a Quest, newest first. */
  listForQuest(guildId: string, questId: string, limit: number): Promise<Proposal[]> {
    return this.store.listForQuest(guildId, questId, limit)
  }

  /** The most recent Proposal of a Quest, or null. */
  latestForQuest(guildId: string, questId: string): Promise<Proposal | null> {
    return this.store.latestForQuest(guildId, questId)
  }

  /** A page of Proposals. */
  list(guildId: string, page: { after?: string; limit: number }): Promise<ProposalPage> {
    return this.store.list(guildId, page)
  }

  /** A page of the Proposals whose Verdict failed, created at or after `since`. */
  listFailedSince(
    guildId: string,
    since: string,
    page: { after?: string; limit: number }
  ): Promise<ProposalPage> {
    return this.store.listFailedSince(guildId, since, page)
  }

  /**
   * The Verdict bound to exactly this Proposal hash, or null when none exists. The Seal and the Core
   * Loop gate on it: no Verdict, or a failing one, means the hash may not be sealed.
   */
  verdictFor(guildId: string, proposalHash: string): Promise<Verdict | null> {
    return this.store.verdictFor(guildId, proposalHash)
  }
}
