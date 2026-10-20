import { z } from 'zod'
import type { HallMissive } from '../missives'
import type { ReplayEvent } from '../replay'

const sentPayload = z.object({ missiveId: z.string(), hall: z.string() })

/**
 * The Halls whose Missives the hall must fetch: those with a `missive.sent` event whose text is
 * not known yet. Events carry ids only, so the text always comes from the session-guarded route.
 */
export function hallsToFetch(
  events: readonly ReplayEvent[],
  known: Readonly<Record<string, string>>
): string[] {
  const halls = new Set<string>()
  for (const event of events) {
    if (event.type !== 'missive.sent') {
      continue
    }
    const p = sentPayload.safeParse(event.payload)
    if (p.success && known[p.data.missiveId] === undefined) {
      halls.add(p.data.hall)
    }
  }
  return [...halls]
}

/** Adds a fetched page's texts (by Missive id) to the known ones. */
export function mergeTexts(
  known: Readonly<Record<string, string>>,
  page: readonly HallMissive[]
): Record<string, string> {
  return { ...known, ...Object.fromEntries(page.map((m) => [m.id, m.text])) }
}
