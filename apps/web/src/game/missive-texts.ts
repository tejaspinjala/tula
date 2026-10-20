import type { HallMissive } from '../missives'
import type { ReplayEvent } from '../replay'

/** Stub. */
export function hallsToFetch(
  _events: readonly ReplayEvent[],
  _known: Readonly<Record<string, string>>
): string[] {
  return []
}

/** Stub. */
export function mergeTexts(
  known: Readonly<Record<string, string>>,
  _page: readonly HallMissive[]
): Record<string, string> {
  return { ...known }
}
