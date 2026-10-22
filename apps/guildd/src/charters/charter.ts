import type { GuildConfig } from '../guild-config'
import type { RiteGraph } from '../rites/graph'

/** Largest Charter document, in bytes. */
export const CHARTER_MAX_BYTES = 256 * 1024

/** How a config key travels in a Charter: `structure` is exported, `local` stays with the guild. */
export type FieldClass = 'structure' | 'local'

/** Classification of every top-level `guildConfig` key. */
export const CONFIG_FIELD_CLASS: Record<string, FieldClass> = {}
/** Classification of every Hall key. */
export const HALL_FIELD_CLASS: Record<string, FieldClass> = {}
/** Classification of every provider key. */
export const PROVIDER_FIELD_CLASS: Record<string, FieldClass> = {}

/** A Charter document. */
export interface Charter {
  charter: 1
  name: string
  exportedAt: string
  config: GuildConfig
  rites: { name: string; graph: RiteGraph }[]
  omitted: { kind: string; id: string; reason: string }[]
}

/** A Rite as the exporter sees it. */
export interface ExportRite {
  id: string
  name: string
  archivedAt: string | null
  /** The graph of the active version, or null when none is active. */
  activeGraph: RiteGraph | null
}

/** Builds a Charter; stub. */
export function exportCharter(_input: {
  name: string
  config: GuildConfig
  rites: ExportRite[]
  now: Date
}): Charter {
  throw new Error('not implemented')
}

/** The outcome of {@link applyCharter}. */
export type ApplyResult =
  | { ok: true; config: GuildConfig; drafts: { name: string; graph: RiteGraph }[] }
  | { ok: false; error: 'invalid_charter'; message: string }

/** Applies a Charter; stub. */
export function applyCharter(_input: {
  charter: Charter
  current: GuildConfig
  existingRiteNames: string[]
}): ApplyResult {
  throw new Error('not implemented')
}
