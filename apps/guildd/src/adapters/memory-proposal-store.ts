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
  private readonly verdicts = new Map<string, Verdict>()

  constructor(private readonly clock: Clock) {}

  /** Proposals keyed by Quest and content hash. */
  private proposals(guildId: string): Map<string, Proposal> {
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
    const proposals = this.proposals(guildId)
    const key = `${input.questId}\u0000${hash}`
    const existing = proposals.get(key)
    if (existing) {
      return this.copy(existing)
    }
    const at = this.clock.now().toISOString()
    // The Verdict is shared by every Proposal of this exact content: the first one writes it.
    const verdictKey = `${guildId}\u0000${hash}`
    const shared: Verdict = this.verdicts.get(verdictKey) ?? {
      proposalHash: hash,
      passed: verdict.passed,
      findings: verdict.findings,
      checkedAt: at,
    }
    this.verdicts.set(verdictKey, structuredClone(shared))
    const proposal: Proposal = {
      ...input,
      id: crypto.randomUUID(),
      hash,
      createdAt: at,
      verdict: structuredClone(shared),
    }
    proposals.set(key, this.copy(proposal))
    return proposal
  }

  async get(guildId: string, id: string): Promise<Proposal | null> {
    for (const p of this.proposals(guildId).values()) {
      if (p.id === id) {
        return this.copy(p)
      }
    }
    return null
  }

  async list(guildId: string, page: { after?: string; limit: number }): Promise<ProposalPage> {
    const matching = [...this.proposals(guildId).values()]
      .filter((p) => page.after === undefined || p.id > page.after)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
    const proposals = matching.slice(0, page.limit).map((p) => this.copy(p))
    const last = proposals.at(-1)
    return { proposals, next: matching.length > page.limit && last ? last.id : null }
  }

  async verdictFor(guildId: string, proposalHash: string): Promise<Verdict | null> {
    const found = this.verdicts.get(`${guildId}\u0000${proposalHash}`)
    return found ? structuredClone(found) : null
  }

  async latestForQuest(_guildId: string, _questId: string): Promise<Proposal | null> {
    throw new Error('not implemented')
  }
}
