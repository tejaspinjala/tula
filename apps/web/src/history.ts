import type { Fetcher } from './artifacts'
import type { Session } from './passkeys'
import type { ReplayEvent } from './replay'

/** Stub: not implemented yet. */
export async function loadHistory(
  _session: Session,
  _fetcher: Fetcher,
  _options: { limit?: number } = {}
): Promise<ReplayEvent[]> {
  return []
}
