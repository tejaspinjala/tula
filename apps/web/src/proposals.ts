import { z } from 'zod'
import type { Fetcher } from './artifacts'
import { PasskeyRequestError, type Session } from './passkeys'

const finding = z.object({ check: z.string(), passed: z.boolean(), detail: z.string() })
const proposalBody = z.object({
  id: z.string(),
  questId: z.string(),
  author: z.string(),
  kind: z.string(),
  content: z.string(),
  hash: z.string(),
  createdAt: z.string(),
  verdict: z.object({
    proposalHash: z.string(),
    passed: z.boolean(),
    findings: z.array(finding),
    checkedAt: z.string(),
  }),
})
const pageBody = z.object({ proposals: z.array(proposalBody), next: z.string().nullable() })

/** A Proposal as the ledger shows it: the exact content, its hash and the Verdict bound to that hash. */
export type LedgerProposal = z.infer<typeof proposalBody>

/** The first page of Proposals, with each one's Verdict findings. */
export async function listProposals(session: Session, fetcher: Fetcher, limit = 20) {
  const res = await fetcher(`/api/guilds/${session.guildId}/proposals?limit=${limit}`, {
    headers: { authorization: `Bearer ${session.token}` },
  })
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const code = z.object({ error: z.string() }).safeParse(data)
    throw new PasskeyRequestError(res.status, code.success ? code.data.error : 'unknown')
  }
  return pageBody.parse(data)
}
