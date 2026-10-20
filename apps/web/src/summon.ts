import type { Fetcher } from './artifacts'
import type { Session } from './passkeys'

/** Where "Summon your first member" stands. */
export interface SummonStatus {
  complete: boolean
  steps: Array<{ id: 'provider' | 'test_quest'; done: boolean }>
  quest: { id: string; state: string } | null
}

/** Reads where the check stands. */
export function loadSummon(_session: Session, _fetcher: Fetcher): Promise<SummonStatus> {
  throw new Error('not implemented')
}

/** Starts the check with the chosen routing profile. */
export function startSummon(
  _session: Session,
  _profileId: string,
  _fetcher: Fetcher
): Promise<SummonStatus> {
  throw new Error('not implemented')
}

/** One sentence on where the check stands; it is only complete once the test Quest has passed. */
export function describeSummon(_status: SummonStatus): string {
  throw new Error('not implemented')
}
