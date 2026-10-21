import { createContext, useContext } from 'react'
import type { ReplayEvent } from './replay'

/**
 * The guild's event stream as the Guild Hall holds it (history plus live), shared with the Bag so a
 * page can refetch when something happens. Events carry ids only, never Missive text.
 */
export const LiveEvents = createContext<readonly ReplayEvent[]>([])

/** The events the Guild Hall has received so far (empty outside it). */
export function useLiveEvents(): readonly ReplayEvent[] {
  return useContext(LiveEvents)
}

/** How many `missive.sent` events a stream holds (a page refetches when this grows). */
export function missiveCount(events: readonly ReplayEvent[]): number {
  return events.filter((e) => e.type === 'missive.sent').length
}

/** How many mailbox events (`inquiry.*`, `dossier.*`, `bug_report.*`) a stream holds (the Mailbox refetches when this grows). */
export function mailboxCount(events: readonly ReplayEvent[]): number {
  return events.filter(
    (e) =>
      e.type.startsWith('inquiry.') ||
      e.type.startsWith('dossier.') ||
      e.type.startsWith('bug_report.')
  ).length
}
