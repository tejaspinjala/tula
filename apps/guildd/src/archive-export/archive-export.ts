import type { Note } from '../ports/note-store'

/** A note to export, with the Hall it is filed under (null: the Guild Master's own). */
export interface ExportNote extends Note {
  hallId: string | null
}

/** One file of the export, at a relative POSIX path. */
export interface ExportFile {
  path: string
  content: string
}

/** Input to {@link buildArchiveExport}. */
export interface ArchiveExportInput {
  notes: readonly ExportNote[]
  halls: readonly { id: string; name: string }[]
  guildName: string
  now: Date
  /** How many private notes the caller left out of `notes`. */
  privateLeftOut: number
  /** Titles of notes withheld from `notes`; links to them render as "[withheld]", never the title. */
  withheldTitles?: readonly string[]
}

/** Builds the linked-Markdown Archive export (ADR-0015): one file per note plus `Archive.md`. Pure. */
export function buildArchiveExport(_input: ArchiveExportInput): ExportFile[] {
  throw new Error('not implemented')
}

/** A file name safe on macOS, Windows and Linux. */
export function sanitiseFileName(_name: string): string {
  throw new Error('not implemented')
}
