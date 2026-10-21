/**
 * The persisted Rite event types. The strings are stored in the chained event log, so they keep the
 * name they were first written under (ADR-0013); this module is the one place that spells them.
 */
export const RITE_EVENT = {
  versionSaved: 'workflow.version_saved',
  versionConfirmed: 'workflow.version_confirmed',
  runStarted: 'workflow.run_started',
} as const

/** The prefix every persisted Rite event type shares. */
export const RITE_EVENT_PREFIX = 'workflow.'
