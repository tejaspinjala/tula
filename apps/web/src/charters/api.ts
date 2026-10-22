import type { Fetcher } from '../artifacts'
import type { Session } from '../passkeys'
import type { Charter } from './schema'

/** The config outcome of an import. */
export interface ImportResult {
  config: { outcome: 'applied' | 'pending' | 'unchanged'; version: number }
  riteIds: string[]
}

/** Thrown when the server refuses a Charter export or import; `code` is its error code. */
export class CharterRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code)
    this.name = 'CharterRefused'
  }
}

/** Downloads the guild as a Charter (`GET /guilds/:id/charter`). */
export function exportCharter(_session: Session, _fetcher: Fetcher): Promise<Charter> {
  return Promise.reject(new Error('not implemented'))
}

/** Imports a Charter (`POST /guilds/:id/charter/import`) against the config version being viewed. */
export function importCharter(
  _session: Session,
  _body: { charter: Charter; baseVersion: number; importId: string },
  _fetcher: Fetcher
): Promise<ImportResult> {
  return Promise.reject(new Error('not implemented'))
}
