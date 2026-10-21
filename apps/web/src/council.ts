import { z } from 'zod'
import type { Fetcher } from './artifacts'
import { formatDollars } from './costs'
import { shortenId } from './GuildId'
import { PasskeyRequestError, type Session } from './passkeys'

// The Council's session route is read only here, validated with Zod. Statuses and votes stay plain
// strings at the boundary: a value a newer server adds still parses and is shown as "Unknown",
// never trusted into markup. Reasons are model text: render them as text only.

const voteBody = z.object({
  voice: z.string(),
  vote: z.string(),
  reasons: z.array(z.string()),
  abstainCode: z.string().nullable(),
})
const sessionBody = z.object({
  id: z.string(),
  questId: z.string(),
  /** The Quest's title, read by the server; null when it is not found in this guild. */
  questTitle: z.string().nullable(),
  proposalHash: z.string(),
  day: z.string(),
  status: z.string(),
  reason: z.string().nullable(),
  createdAt: z.string(),
  sealId: z.string().nullable(),
  /** Open but stopped by Bar the Gates, with no vote cast since. */
  halted: z.boolean(),
  costMicros: z.number().nullable(),
  votes: z.array(voteBody),
})
const pageBody = z.object({ sessions: z.array(sessionBody), next: z.string().nullable() })

/** One Council voice's vote. */
export type CouncilVoteView = z.infer<typeof voteBody>

/** One Council session as the panel shows it. */
export type CouncilSessionView = z.infer<typeof sessionBody>

/** Reads one page of the Council's sessions, newest first. */
export async function loadCouncilSessions(
  session: Session,
  fetcher: Fetcher,
  query: { limit: number; after?: string }
): Promise<{ sessions: CouncilSessionView[]; next: string | null }> {
  const after = query.after === undefined ? '' : `&after=${encodeURIComponent(query.after)}`
  const res = await fetcher(
    `/api/guilds/${session.guildId}/council/sessions?limit=${query.limit}${after}`,
    {
      headers: { authorization: `Bearer ${session.token}` },
    }
  )
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const code = z.object({ error: z.string() }).safeParse(data)
    throw new PasskeyRequestError(res.status, code.success ? code.data.error : 'unknown')
  }
  return pageBody.parse(data)
}

/** The first eight characters of a Proposal hash: enough to tell sessions apart. */
export function proposalPrefix(hash: string): string {
  return hash.slice(0, 8)
}

/** A session's cost: dollars, or a note when no voice was metered. */
export function councilCostText(micros: number | null): string {
  return micros === null ? 'not metered' : formatDollars(micros)
}

const STATUS_LABELS: Record<string, string> = {
  open: 'Conferring',
  escalated: 'Sent to the Seal desk',
  approved: 'Approved',
  halted: 'Halted',
}

/** A session status in words; a status this client does not know reads as "Unknown". */
export function councilStatusLabel(status: string): string {
  return Object.hasOwn(STATUS_LABELS, status) ? (STATUS_LABELS[status] ?? 'Unknown') : 'Unknown'
}

const VOTE_LABELS: Record<string, string> = {
  approve: 'Approve',
  block: 'Block',
  abstain: 'Abstain',
}

/** A vote in words; anything else reads as "Unknown". */
export function councilVoteLabel(vote: string): string {
  return Object.hasOwn(VOTE_LABELS, vote) ? (VOTE_LABELS[vote] ?? 'Unknown') : 'Unknown'
}

/** A session's status in words, "Halted" while Bar the Gates holds an open one. */
export function councilSessionLabel(session: { status: string; halted: boolean }): string {
  return session.status === 'open' && session.halted
    ? 'Halted: the Gates are barred'
    : councilStatusLabel(session.status)
}

/** A Quest as the Council reads name it: its title, else its short id. */
export function questName(quest: { questId: string; questTitle: string | null }): string {
  return quest.questTitle ?? shortenId(quest.questId)
}

/** What the map's chamber shows: the elders confer, stand halted by Bar the Gates, or idle. */
export type CouncilChamberState = 'idle' | 'conferring' | 'halted'

/** The chamber's state for the newest sessions. */
export function councilChamberState(
  sessions: readonly { status: string; halted: boolean }[]
): CouncilChamberState {
  if (councilOpenNow(sessions)) {
    return 'conferring'
  }
  return sessions.some((s) => s.status === 'open' && s.halted) ? 'halted' : 'idle'
}

/** Whether any of these sessions is still open: the elders confer while one is. */
export function councilOpenNow(sessions: readonly { status: string; halted: boolean }[]): boolean {
  return sessions.some((s) => s.status === 'open' && !s.halted)
}
