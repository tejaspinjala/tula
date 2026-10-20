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

  constructor(deps: { store: ProposalStore; policy?: ContentPolicy }) {
    this.store = deps.store
    this.policy = deps.policy ?? DEFAULT_POLICY
  }

  /** Stores the Proposal with its Verdict. Idempotent per content hash. */
  propose(guildId: string, input: NewProposal): Promise<Proposal> {
    const findings = runChecks(input.content, this.policy)
    return this.store.propose(guildId, input, { passed: allPassed(findings), findings })
  }

  /** One Proposal, or null. */
  get(guildId: string, id: string): Promise<Proposal | null> {
    return this.store.get(guildId, id)
  }

  /** A page of Proposals. */
  list(guildId: string, page: { after?: string; limit: number }): Promise<ProposalPage> {
    return this.store.list(guildId, page)
  }

  /**
   * The Verdict bound to exactly this Proposal hash, or null when none exists. The Seal and the Core
   * Loop gate on it: no Verdict, or a failing one, means the hash may not be sealed.
   */
  verdictFor(guildId: string, proposalHash: string): Promise<Verdict | null> {
    return this.store.verdictFor(guildId, proposalHash)
  }
}
