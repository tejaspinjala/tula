/** A Quest template the inspector offers for an agent node. */
export interface TemplateChoice {
  id: string
  name: string
  hallId: string
  requiresSeal: boolean
}

/**
 * The Quest templates the server posts from, as the picker needs them. A copy, not an import, so
 * the browser bundle does not pull in guildd's server code; `templates.test.ts` fails if it drifts.
 */
export const QUEST_TEMPLATE_CHOICES: readonly TemplateChoice[] = [
  { id: 'herald-brief', name: 'Herald brief', hallId: 'heralds', requiresSeal: false },
  {
    id: 'herald-announcement',
    name: 'Herald announcement',
    hallId: 'heralds',
    requiresSeal: true,
  },
  { id: 'team-plan', name: 'Team plan', hallId: 'heralds', requiresSeal: false },
  { id: 'health-log', name: 'Health log', hallId: 'health', requiresSeal: false },
  { id: 'personal-plan', name: 'Personal plan', hallId: 'personal', requiresSeal: false },
  {
    id: 'relationship-note',
    name: 'Relationship note',
    hallId: 'relationships',
    requiresSeal: false,
  },
]
