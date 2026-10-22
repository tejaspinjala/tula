import type { BuilderConfig } from '../builder/model'
import type { Charter } from './schema'

/** One setting an import would change. */
export interface SettingChange {
  label: string
  from: string
  to: string
}

/** What importing a Charter would do, shown before anything is sent. */
export interface CharterPreview {
  hallsAdded: string[]
  hallsRemoved: string[]
  settings: SettingChange[]
  ritesAdded: string[]
  kept: string[]
}

/** Compares this guild's config with a Charter's: Halls, caps, Seal Policy and the rest, Rites to add, fields kept. */
export function previewCharter(_current: BuilderConfig, _charter: Charter): CharterPreview {
  throw new Error('not implemented')
}
