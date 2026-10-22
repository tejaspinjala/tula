/**
 * The persisted Rite event types as the guildd event log stores them (ADR-0013). The strings keep
 * the name they were first written under; this module is the one place the web spells them.
 */
export const RITE_EVENT = {
  versionSaved: 'workflow.version_saved',
  versionConfirmed: 'workflow.version_confirmed',
  runStarted: 'workflow.run_started',
} as const

/** The prefix every persisted Rite event type shares. */
export const RITE_EVENT_PREFIX = 'workflow.'
