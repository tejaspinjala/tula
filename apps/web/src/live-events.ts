import { createContext, useContext, useEffect, useState } from 'react'
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

/** How many `council.*` events a stream holds (the Council panel and chamber refetch when this grows). */
export function councilCount(events: readonly ReplayEvent[]): number {
  return events.filter((e) => e.type.startsWith('council.')).length
}

/** How long a burst of `council.*` events must stay quiet before the ledger is read again. */
export const COUNCIL_REFETCH_DEBOUNCE_MS = 300

/**
 * A count that follows `count` only once it has held still for `ms`, so a burst of events (a
 * session writes seven in a row) triggers one refetch instead of one each. The first value is
 * taken at once.
 */
export function useSettledCount(count: number, ms: number): number {
  const [settled, setSettled] = useState(count)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(count), ms)
    return () => clearTimeout(timer)
  }, [count, ms])
  return settled
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
