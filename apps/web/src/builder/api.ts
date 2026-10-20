import type { Fetcher } from '../artifacts'
import type { PasskeyBrowser, Session } from '../passkeys'
import type { BuilderConfig } from './model'

/** What a save or restore reports; `pending` means a widening change awaits the passkey confirm. */
export interface SaveOutcome {
  version: number
  status: 'applied' | 'pending'
  change: 'tightening' | 'neutral' | 'widening'
}

/** One validation problem the server found, with the path to the offending field. */
export interface ConfigIssue {
  path: (string | number)[]
  message: string
}

/** Thrown when the server refuses a config as invalid. */
export class SaveRejected extends Error {
  constructor(readonly issues: ConfigIssue[]) {
    super('invalid_config')
    this.name = 'SaveRejected'
  }
}

/** One row of the version history. */
export interface VersionRow {
  version: number
  status: 'applied' | 'pending'
  kind: 'seed' | 'change' | 'restore'
  change: SaveOutcome['change']
  createdAt: string
}

function todo(): never {
  throw new Error('not implemented')
}

/** Loads the config in force and its version. */
export async function loadCurrent(
  _session: Session,
  _fetcher: Fetcher
): Promise<{ version: number; config: BuilderConfig }> {
  return todo()
}

/** Saves an edited config through `PUT /guilds/:id/config`. */
export async function saveConfig(
  _session: Session,
  _config: BuilderConfig,
  _fetcher: Fetcher
): Promise<SaveOutcome> {
  return todo()
}

/** Confirms a pending widening version after a fresh passkey re-authentication. */
export async function confirmVersion(
  _session: Session,
  _version: number,
  _fetcher: Fetcher,
  _browser: PasskeyBrowser
): Promise<void> {
  return todo()
}

/** Restores an earlier version as a new one. */
export async function restoreVersion(
  _session: Session,
  _version: number,
  _fetcher: Fetcher
): Promise<SaveOutcome> {
  return todo()
}

/** Loads the newest versions, without their documents. */
export async function loadVersions(_session: Session, _fetcher: Fetcher): Promise<VersionRow[]> {
  return todo()
}
