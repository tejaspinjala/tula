import type { Fetcher } from './artifacts'
import type { Session } from './passkeys'

/** One line of the scroll. */
export interface DigestEntry {
  seq: number
  kind: string
  occurredAt: string
  questId: string | null
  sessionId: string | null
  sealId: string | null
  reason: string | null
  amountCents: number | null
  status: string | null
}

/** One page of the digest. */
export interface AwayDigestPage {
  window: { since: string; until: string | null; open: boolean } | null
  entries: DigestEntry[]
  next: number | null
}

/** Event told on `window` when the Guild Master returns. */
export const AWAY_RETURNED_EVENT = 'guildhall:returned'
/** Event told on `window` to reopen the scroll. */
export const AWAY_REOPEN_EVENT = 'guildhall:reopen-away-scroll'

/** Reads one page of the digest. */
export async function loadAwayDigest(
  _session: Session,
  _fetcher: Fetcher,
  _query: { after?: number; limit?: number } = {}
): Promise<AwayDigestPage> {
  return { window: null, entries: [], next: null }
}

/** Whether the scroll for the window starting at `since` was already shown to this viewer. */
export function scrollSeen(_session: Session, _since: string): boolean {
  return false
}

/** Remembers that the scroll for the window starting at `since` was shown. */
export function markScrollSeen(_session: Session, _since: string): void {}

/** Tells the app the Guild Master returned, so the scroll can open. */
export function announceReturn(): void {}

/** Asks the app to reopen the scroll. */
export function requestAwayScroll(): void {}

/** One plain sentence for a digest entry. */
export function digestLine(_entry: DigestEntry): string {
  return ''
}
