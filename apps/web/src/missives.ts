import { z } from 'zod'
import type { Fetcher } from './artifacts'
import type { Session } from './passkeys'

/** One Missive as the ledger shows it: the sender's own text, to be rendered as text only. */
export interface HallMissive {
  id: string
  from: string
  to: string
  text: string
  sentAt: string
}

/** One page of a Hall's Missives, newest first; `next` is the cursor of the following page. */
export interface MissivePage {
  missives: HallMissive[]
  next: number | null
}

/** Reads one page of the Hall's Missives (session-guarded). */
export async function loadMissives(
  _session: Session,
  _fetcher: Fetcher,
  _hallId: string,
  _options: { limit: number; after?: number }
): Promise<MissivePage> {
  throw new Error('not implemented')
}

/** The Missives `memberId` sent or received. */
export function missivesOf(_missives: readonly HallMissive[], _memberId: string): HallMissive[] {
  return []
}

export const _unused = z
