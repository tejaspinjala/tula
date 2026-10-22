/**
 * The persisted Archive export event types. The strings are stored in the chained event log, so
 * this module is the one place that spells them.
 */
export const ARCHIVE_EVENT = {
  exported: 'archive.exported',
} as const
