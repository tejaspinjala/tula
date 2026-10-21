import { z } from 'zod'
import type { Fetcher } from './artifacts'
import { PasskeyRequestError, type Session } from './passkeys'
import { formatCents } from './treasury'

// The digest is read only here, validated with Zod. Kinds, reasons and statuses stay plain strings
// at the boundary: a value a newer server adds still parses and reads as "Something happened",
// never trusted into markup.

const entryBody = z.object({
  seq: z.number(),
  kind: z.string(),
  occurredAt: z.string(),
  questId: z.string().nullable(),
  sessionId: z.string().nullable(),
  sealId: z.string().nullable(),
  reason: z.string().nullable(),
  amountCents: z.number().nullable(),
  status: z.string().nullable(),
})
const pageBody = z.object({
  window: z
    .object({ since: z.string(), until: z.string().nullable(), open: z.boolean() })
    .nullable(),
  entries: z.array(entryBody),
  next: z.number().nullable(),
})

/** One line of the scroll. */
export type DigestEntry = z.infer<typeof entryBody>

/** One page of the digest: the window it covers, its entries oldest first, and the next cursor. */
export type AwayDigestPage = z.infer<typeof pageBody>

/** Event told on `window` when the Guild Master returns. */
export const AWAY_RETURNED_EVENT = 'guildhall:returned'
/** Event told on `window` to reopen the scroll. */
export const AWAY_REOPEN_EVENT = 'guildhall:reopen-away-scroll'

/** Reads one page of the latest away window's digest, oldest first. */
export async function loadAwayDigest(
  session: Session,
  fetcher: Fetcher,
  query: { after?: number; limit?: number } = {}
): Promise<AwayDigestPage> {
  const params = new URLSearchParams()
  if (query.limit !== undefined) {
    params.set('limit', String(query.limit))
  }
  if (query.after !== undefined) {
    params.set('after', String(query.after))
  }
  const search = params.size > 0 ? `?${params.toString()}` : ''
  const res = await fetcher(`/api/guilds/${session.guildId}/guild-master/away-digest${search}`, {
    headers: { authorization: `Bearer ${session.token}` },
  })
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const code = z.object({ error: z.string() }).safeParse(data)
    throw new PasskeyRequestError(res.status, code.success ? code.data.error : 'unknown')
  }
  return pageBody.parse(data)
}

const seenKey = (session: Session): string => `guildhall.awayScrollSeen.${session.guildId}`

/** Whether the scroll for the window starting at `since` was already shown to this viewer. */
export function scrollSeen(session: Session, since: string): boolean {
  try {
    return localStorage.getItem(seenKey(session)) === since
  } catch {
    return false
  }
}

/** Remembers that the scroll for the window starting at `since` was shown; storage may be blocked. */
export function markScrollSeen(session: Session, since: string): void {
  try {
    localStorage.setItem(seenKey(session), since)
  } catch {
    // Private mode or a full disk: the scroll may open once more, which is harmless.
  }
}

/** Tells the app the Guild Master returned, so the scroll can open. */
export function announceReturn(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(AWAY_RETURNED_EVENT))
  }
}

/** Asks the app to reopen the scroll. */
export function requestAwayScroll(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(AWAY_REOPEN_EVENT))
  }
}

/** One plain sentence for a digest entry. */
export function digestLine(entry: DigestEntry): string {
  switch (entry.kind) {
    case 'council_approved':
      return 'The Council approved a routine Proposal in place of a Seal.'
    case 'escalated':
      return `The Council sent a Proposal to your Seal desk${entry.reason ? `: ${entry.reason}` : ''}.`
    case 'seal_waiting':
      return 'A Seal is still waiting for you.'
    case 'quest_done':
      return 'A Quest is done.'
    case 'spend':
      return `Treasury spend${entry.amountCents === null ? '' : ` ${formatCents(entry.amountCents)}`}${entry.status ? ` (${entry.status})` : ''}.`
    default:
      return 'Something happened.'
  }
}
