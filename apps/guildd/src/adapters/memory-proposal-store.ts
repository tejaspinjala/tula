import type { Clock } from '../ports/clock'
import type {
  NewProposal,
  Proposal,
  ProposalPage,
  ProposalStore,
  Verdict,
} from '../ports/proposal-store'
import { hashProposal } from '../ports/seal-store'
import type { Finding } from '../verdict'

/**
 * Memory adapter for {@link ProposalStore}: state in this instance only. Hashing happens first, then
 * the check and the write run with no await between them, so same-tick calls cannot interleave.
 */
export class MemoryProposalStore implements ProposalStore {
  private readonly guilds = new Map<string, Map<string, Proposal>>()

  constructor(private readonly clock: Clock) {}

  private byHash(guildId: string): Map<string, Proposal> {
    let proposals = this.guilds.get(guildId)
    if (!proposals) {
      proposals = new Map()
      this.guilds.set(guildId, proposals)
    }
    return proposals
  }

  private copy(p: Proposal): Proposal {
    return structuredClone(p)
  }

  async propose(
    guildId: string,
    input: NewProposal,
    verdict: { passed: boolean; findings: Finding[] }
  ): Promise<Proposal> {
    const hash = await hashProposal(input.content)
    const proposals = this.byHash(guildId)
    const existing = proposals.get(hash)
    if (existing) {
      return this.copy(existing)
    }
    const at = this.clock.now().toISOString()
    const proposal: Proposal = {
      ...input,
      id: crypto.randomUUID(),
      hash,
      createdAt: at,
      verdict: {
        proposalHash: hash,
        passed: verdict.passed,
        findings: verdict.findings,
        checkedAt: at,
      },
    }
    proposals.set(hash, this.copy(proposal))
    return proposal
  }

  async get(guildId: string, id: string): Promise<Proposal | null> {
    for (const p of this.byHash(guildId).values()) {
      if (p.id === id) {
        return this.copy(p)
      }
    }
    return null
  }

  async list(guildId: string, page: { after?: string; limit: number }): Promise<ProposalPage> {
    const matching = [...this.byHash(guildId).values()]
      .filter((p) => page.after === undefined || p.id > page.after)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
    const proposals = matching.slice(0, page.limit).map((p) => this.copy(p))
    const last = proposals.at(-1)
    return { proposals, next: matching.length > page.limit && last ? last.id : null }
  }

  async verdictFor(guildId: string, proposalHash: string): Promise<Verdict | null> {
    const found = this.byHash(guildId).get(proposalHash)
    return found ? structuredClone(found.verdict) : null
  }
}
