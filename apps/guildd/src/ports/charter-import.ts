import type { GuildConfig } from '../guild-config'
import type { RiteChangeKind } from '../rites/classify'
import type { RiteGraph } from '../rites/graph'

/** One Rite an import creates, as a draft; the id is chosen by the caller so a replay repeats it. */
export interface CharterImportDraft {
  riteId: string
  name: string
  graph: RiteGraph
  classification: RiteChangeKind
}

/** What an import writes: the config the Charter proposes and the Rite drafts it carries. */
export interface CharterImportInput {
  /** Caller-chosen key: the same `importId` for a guild returns the first result and writes nothing. */
  importId: string
  /** The config version the caller was viewing; a moved version is refused `stale`. */
  baseVersion: number
  config: GuildConfig
  drafts: CharterImportDraft[]
}

/** The stored and returned result of an import. */
export interface CharterImportResult {
  config: { outcome: 'applied' | 'pending' | 'unchanged'; version: number }
  riteIds: string[]
}

/** The outcome of {@link CharterImporter.importCharter}. */
export type CharterImportOutcome =
  | { ok: true; result: CharterImportResult; replayed: boolean }
  | { ok: false; error: 'stale' | 'seal_policy_locked' }

/**
 * Port for importing a Charter. The config proposal (through the normal propose/classify rules),
 * the Rite drafts, the `charter.imported` event and the idempotency record are written all or
 * nothing. Importing grants no authority: a widening config stays pending, Rites stay drafts.
 */
export interface CharterImporter {
  /** Applies the import once per `importId`; a repeat returns the first result with `replayed`. */
  importCharter(guildId: string, input: CharterImportInput): Promise<CharterImportOutcome>
}
