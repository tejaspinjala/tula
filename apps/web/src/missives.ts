import { z } from 'zod'
import type { Fetcher } from './artifacts'
import { PasskeyRequestError, type Session } from './passkeys'

const missiveBody = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  text: z.string(),
  hallId: z.string(),
  toHall: z.string().nullable(),
  sentAt: z.string(),
})
const pageBody = z.object({ missives: z.array(missiveBody), next: z.number().nullable() })

/** One Missive as the ledger shows it: the sender's own text, to be rendered as text only. */
export type HallMissive = z.infer<typeof missiveBody>

/** One page of a Hall's Missives, newest first; `next` is the cursor of the following page. */
export type MissivePage = z.infer<typeof pageBody>

/** Reads one page of the Hall's Missives (session-guarded). */
export async function loadMissives(
  session: Session,
  fetcher: Fetcher,
  hallId: string,
  options: { limit: number; after?: number }
): Promise<MissivePage> {
  const query = `limit=${options.limit}${options.after === undefined ? '' : `&after=${options.after}`}`
  const res = await fetcher(
    `/api/guilds/${session.guildId}/halls/${encodeURIComponent(hallId)}/missives?${query}`,
    { headers: { authorization: `Bearer ${session.token}` } }
  )
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const code = z.object({ error: z.string() }).safeParse(data)
    throw new PasskeyRequestError(res.status, code.success ? code.data.error : 'unknown')
  }
  return pageBody.parse(data)
}

/** The Missives `memberId` sent or received, plus those sent to the whole Hall (`hall`); the list is one Hall's. */
export function missivesOf(missives: readonly HallMissive[], memberId: string): HallMissive[] {
  return missives.filter((m) => m.from === memberId || m.to === memberId || m.to === 'hall')
}

/**
 * The label a ledger row carries when the Missive crossed Halls, seen from `viewedHall`: "from
 * <Hall>" for one that arrived, "to <Hall>" for one that left; null for a Missive inside the Hall.
 */
export function crossHallLabel(
  missive: HallMissive,
  viewedHall: string,
  hallName: (hallId: string) => string
): string | null {
  if (missive.toHall === null) {
    return null
  }
  return missive.hallId === viewedHall
    ? `to ${hallName(missive.toHall)}`
    : `from ${hallName(missive.hallId)}`
}
