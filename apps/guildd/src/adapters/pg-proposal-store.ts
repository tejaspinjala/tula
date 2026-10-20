import { z } from 'zod'
import type { Db, TenantTx } from '../db/client'
import { appendEvent } from '../events'
import type { Clock } from '../ports/clock'
import type { KeyProvider } from '../ports/key-provider'
import type {
  NewProposal,
  Proposal,
  ProposalPage,
  ProposalStore,
  Verdict,
} from '../ports/proposal-store'
import { hashProposal } from '../ports/seal-store'
import { type Finding, finding } from '../verdict'

const date = z.date().transform((d) => d.toISOString())
const row = z.object({
  proposal_id: z.string(),
  quest_id: z.string(),
  author: z.string(),
  kind: z.string(),
  content: z.string(),
  content_hash: z.string(),
  created_at: date,
  passed: z.boolean(),
  findings: z.array(finding),
  checked_at: date,
})
type Row = z.infer<typeof row>
const verdictRow = z.object({
  passed: z.boolean(),
  findings: z.array(finding),
  checked_at: date,
})

const SELECT = `p.proposal_id, p.quest_id, p.author, p.kind, p.content, p.content_hash, p.created_at,
  v.passed, v.findings, v.checked_at`

function toProposal(r: Row): Proposal {
  return {
    id: r.proposal_id,
    questId: r.quest_id,
    author: r.author,
    kind: r.kind,
    content: r.content,
    hash: r.content_hash,
    createdAt: r.created_at,
    verdict: {
      proposalHash: r.content_hash,
      passed: r.passed,
      findings: r.findings,
      checkedAt: r.checked_at,
    },
  }
}

/**
 * Postgres {@link ProposalStore}: every call runs in `Db.withGuild` (RLS scopes it to one guild).
 * A Proposal and its Verdict insert in one transaction with their events (ids and hashes only);
 * triggers make both immutable, and a CHECK binds the hash to the content.
 */
export class PgProposalStore implements ProposalStore {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider,
    private readonly clock: Clock
  ) {}

  private async ofQuest(
    tx: TenantTx,
    guildId: string,
    questId: string,
    hash: string
  ): Promise<Proposal | null> {
    const [found] = await tx`
      select ${tx.unsafe(SELECT)} from proposals p
      join verdicts v on v.guild_id = p.guild_id and v.proposal_hash = p.content_hash
      where p.guild_id = ${guildId} and p.quest_id = ${questId} and p.content_hash = ${hash}`
    return found ? toProposal(row.parse(found)) : null
  }

  async propose(
    guildId: string,
    input: NewProposal,
    verdict: { passed: boolean; findings: Finding[] }
  ): Promise<Proposal> {
    const now = this.clock.now()
    const hash = await hashProposal(input.content)
    return this.db.withGuild(guildId, async (tx) => {
      const [inserted] = await tx`
        insert into proposals (guild_id, quest_id, author, kind, content, content_hash, created_at)
        values (${guildId}, ${input.questId}, ${input.author}, ${input.kind}, ${input.content},
          ${hash}, ${now})
        on conflict (guild_id, quest_id, content_hash) do nothing
        returning proposal_id`
      if (inserted) {
        const id = z.object({ proposal_id: z.string() }).parse(inserted).proposal_id
        // The Verdict is shared by every Proposal of this exact content: the first one writes it.
        const recorded = await tx`
          insert into verdicts (guild_id, proposal_hash, passed, findings, checked_at)
          values (${guildId}, ${hash}, ${verdict.passed}, ${JSON.stringify(verdict.findings)}::text::jsonb, ${now})
          on conflict (guild_id, proposal_hash) do nothing
          returning passed`
        await appendEvent(tx, this.keys, 'proposal.created', {
          proposalId: id,
          questId: input.questId,
          proposalHash: hash,
        })
        if (recorded.length > 0) {
          await appendEvent(tx, this.keys, 'verdict.recorded', {
            proposalId: id,
            proposalHash: hash,
            passed: verdict.passed,
          })
        }
      }
      const stored = await this.ofQuest(tx, guildId, input.questId, hash)
      if (!stored) {
        throw new Error('proposal vanished after insert')
      }
      return stored
    })
  }

  async get(guildId: string, id: string): Promise<Proposal | null> {
    return this.db.withGuild(guildId, async (tx) => {
      const [found] = await tx`
        select ${tx.unsafe(SELECT)} from proposals p
        join verdicts v on v.guild_id = p.guild_id and v.proposal_hash = p.content_hash
        where p.guild_id = ${guildId} and p.proposal_id = ${id}`
      return found ? toProposal(row.parse(found)) : null
    })
  }

  async list(guildId: string, page: { after?: string; limit: number }): Promise<ProposalPage> {
    const after = page.after ?? null
    return this.db.withGuild(guildId, async (tx) => {
      const rows = await tx`
        select ${tx.unsafe(SELECT)} from proposals p
        join verdicts v on v.guild_id = p.guild_id and v.proposal_hash = p.content_hash
        where p.guild_id = ${guildId}
          and (${after}::uuid is null or p.proposal_id > ${after}::uuid)
        order by p.proposal_id limit ${page.limit + 1}`
      const all = rows.map((r) => toProposal(row.parse(r)))
      const proposals = all.slice(0, page.limit)
      const last = proposals.at(-1)
      return { proposals, next: all.length > page.limit && last ? last.id : null }
    })
  }

  async verdictFor(guildId: string, proposalHash: string): Promise<Verdict | null> {
    return this.db.withGuild(guildId, async (tx) => {
      const [found] = await tx`
        select passed, findings, checked_at from verdicts
        where guild_id = ${guildId} and proposal_hash = ${proposalHash}`
      if (!found) {
        return null
      }
      const v = verdictRow.parse(found)
      return {
        proposalHash,
        passed: v.passed,
        findings: v.findings,
        checkedAt: v.checked_at,
      }
    })
  }
}
