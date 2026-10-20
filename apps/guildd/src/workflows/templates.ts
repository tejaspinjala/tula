import type { WorkflowGraph } from './graph'

/** The id the seeded template is saved under. */
export const LEARNING_TO_LINKEDIN_ID = 'learning-to-linkedin'

/**
 * The seeded template "Learning to LinkedIn post" (SPEC 27.8, simplified): a manual trigger, a
 * Herald draft, then the gate (Verdict, Seal bound to the same hash) and a manual publish.
 */
export const LEARNING_TO_LINKEDIN: WorkflowGraph = {
  nodes: [
    { id: 'start', type: 'trigger.manual', name: 'Start' },
    {
      id: 'draft',
      type: 'agent',
      name: 'Heralds draft',
      hallId: 'heralds',
      templateId: 'herald-announcement',
      briefTemplate: 'Draft a LinkedIn post about what the guild learned this week.',
      doneCondition: 'A LinkedIn post draft is ready for a Seal',
      maxUsd: 1,
    },
    { id: 'check', type: 'verify', name: 'Verdict', of: 'draft' },
    { id: 'seal', type: 'approval', name: 'Seal', of: 'check' },
    { id: 'publish', type: 'post', name: 'Publish', of: 'seal' },
  ],
  edges: [
    { from: 'start', to: 'draft' },
    { from: 'draft', to: 'check' },
    { from: 'check', to: 'seal' },
    { from: 'seal', to: 'publish' },
  ],
}
