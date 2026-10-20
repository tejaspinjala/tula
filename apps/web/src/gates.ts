import type { Fetcher } from './artifacts'
import type { PasskeyBrowser, Session } from './passkeys'

/** Which bars are up for the signed-in guild. */
export interface GatesStatus {
  guild: boolean
  global: boolean
}

/** What barring stopped. */
export interface BarResult {
  barId: string
  scope: 'guild' | 'global'
  created: boolean
  revokedRuns: number
  killedSandboxes: number
}

/** Reads which bars are up. */
export async function loadGates(_session: Session, _fetcher: Fetcher): Promise<GatesStatus> {
  throw new Error('not implemented')
}

/** Bars the Gates for the guild or every guild; immediate, no re-authentication. */
export async function barGates(
  _session: Session,
  _scope: 'guild' | 'global',
  _fetcher: Fetcher
): Promise<BarResult> {
  throw new Error('not implemented')
}

/** Lifts the bar after a fresh passkey re-authentication. */
export async function liftGates(
  _session: Session,
  _scope: 'guild' | 'global',
  _fetcher: Fetcher,
  _browser: PasskeyBrowser
): Promise<void> {
  throw new Error('not implemented')
}

/** One sentence describing the bars. */
export function describeGates(_status: GatesStatus): string {
  return ''
}
