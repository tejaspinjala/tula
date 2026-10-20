import type { Finding } from '../verdict'

/** Largest page a {@link ProposalStore.list} call returns. */
export const MAX_PROPOSAL_PAGE = 100

/** Input to {@link ProposalStore.propose}. The store derives the hash from `content` itself. */
export interface NewProposal {
  questId: string
  /** The Member that drafted it. */
  author: string
  /** What is being proposed, e.g. `post`. */
  kind: string
  /** The exact drafted text; the hash binds to it and to nothing else. */
  content: string
}

/** The result of the deterministic checks, bound to one Proposal hash and never changed. */
export interface Verdict {
  /** SHA-256 of the exact content this Verdict judged; it applies to no other content. */
  proposalHash: string
  passed: boolean
  findings: Finding[]
  checkedAt: string
}

/** A Proposal: drafted content bound to its hash, with the Verdict that judged exactly that content. */
export interface Proposal extends NewProposal {
  id: string
  /** SHA-256 of `content`, computed by the store. */
  hash: string
  createdAt: string
  verdict: Verdict
}

/** One page of Proposals in id order; `next` is the cursor for the following page, null at the end. */
export interface ProposalPage {
  proposals: Proposal[]
  next: string | null
}

/**
 * Port for Proposals and their Verdicts. A Proposal and its Verdict are written together, atomically,
 * and neither can change afterwards: an edit is a new Proposal with a new hash. Events carry ids and
 * hashes only.
 */
export interface ProposalStore {
  /**
   * Stores the Proposal with its Verdict. Idempotent per Quest and content hash within a guild:
   * the same content under the same Quest returns the existing Proposal. The same content under
   * another Quest is that Quest's own Proposal, and shares the first Verdict written for that hash.
   */
  propose(
    guildId: string,
    input: NewProposal,
    verdict: { passed: boolean; findings: Finding[] }
  ): Promise<Proposal>
  /** The Proposal, or null when absent for this guild. */
  get(guildId: string, id: string): Promise<Proposal | null>
  /** Proposals in id order strictly after `after`. */
  list(guildId: string, page: { after?: string; limit: number }): Promise<ProposalPage>
  /**
   * Proposals whose Verdict failed, created at or after `since` (an ISO instant), in id order
   * strictly after `after`. Indexed by creation time, so a pass over the recent past never reads
   * older Proposals.
   */
  listFailedSince(
    guildId: string,
    since: string,
    page: { after?: string; limit: number }
  ): Promise<ProposalPage>
  /** The Verdict bound to exactly this Proposal hash, or null; the Seal and Core Loop gate on it. */
  verdictFor(guildId: string, proposalHash: string): Promise<Verdict | null>
  /** Up to `limit` Proposals of the Quest, newest first; empty when it has none. */
  listForQuest(guildId: string, questId: string, limit: number): Promise<Proposal[]>
  /** The most recently stored Proposal of the Quest (a revision round drafts a new one), or null. */
  latestForQuest(guildId: string, questId: string): Promise<Proposal | null>
}
